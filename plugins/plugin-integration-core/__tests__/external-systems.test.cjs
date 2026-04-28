'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createExternalSystemRegistry,
  ExternalSystemNotFoundError,
  ExternalSystemValidationError,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'external-systems.cjs'))

function createMockCredentialStore() {
  return {
    source: 'host-security',
    format: 'enc',
    calls: [],
    async encrypt(value) {
      this.calls.push(['encrypt', value])
      return `enc:${Buffer.from(value, 'utf8').toString('base64')}`
    },
    async decrypt(value) {
      this.calls.push(['decrypt', value])
      return Buffer.from(value.slice(4), 'base64').toString('utf8')
    },
    async fingerprint(value) {
      this.calls.push(['fingerprint', value])
      return `fp_${Buffer.from(value).toString('hex').slice(0, 13)}`.slice(0, 16)
    },
  }
}

function createMockDb() {
  const rows = []
  const calls = []

  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    rows,
    calls,
    async selectOne(table, where) {
      calls.push(['selectOne', table, { ...where }])
      return rows.find(row => matchesWhere(row, where)) || null
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table, { ...row }])
      const stored = {
        ...row,
        created_at: row.created_at || '2026-04-24T00:00:00.000Z',
        updated_at: row.updated_at || '2026-04-24T00:00:00.000Z',
      }
      rows.push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = rows.find(candidate => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-04-24T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      const filtered = rows.filter(row => matchesWhere(row, options.where || {}))
      return filtered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
  }
}

async function main() {
  const db = createMockDb()
  const credentialStore = createMockCredentialStore()
  const registry = createExternalSystemRegistry({
    db,
    credentialStore,
    idGenerator: () => 'sys_1',
  })

  // --- 1. Create encrypts credentials and returns public-safe shape ------
  const created = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    workspaceId: null,
    projectId: 'project_1',
    name: 'K3 WISE',
    kind: 'erp:k3-wise-webapi',
    role: 'source',
    config: { baseUrl: 'https://k3.example.test' },
    credentials: { username: 'u', password: 'secret' },
    capabilities: { read: true, write: false },
    status: 'active',
  })

  assert.equal(created.id, 'sys_1')
  assert.equal(created.tenantId, 'tenant_1')
  assert.equal(created.workspaceId, null)
  assert.equal(created.hasCredentials, true)
  assert.equal(created.credentialFormat, 'enc')
  assert.match(created.credentialFingerprint, /^fp_/)
  assert.equal(created.credentials, undefined, 'public result never exposes plaintext credentials')
  assert.equal(db.rows[0].credentials_encrypted.startsWith('enc:'), true, 'stored credentials are host-encrypted')
  assert.deepEqual(credentialStore.calls[0][0], 'encrypt')

  // --- 2. Update without credentials preserves encrypted value -----------
  const previousCiphertext = db.rows[0].credentials_encrypted
  const updated = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'sys_1',
    name: 'K3 WISE renamed',
    kind: 'erp:k3-wise-webapi',
    role: 'source',
    config: { baseUrl: 'https://k3-new.example.test' },
    capabilities: { read: true, write: true },
    status: 'inactive',
  })

  assert.equal(updated.id, 'sys_1')
  assert.equal(updated.name, 'K3 WISE renamed')
  assert.equal(db.rows[0].credentials_encrypted, previousCiphertext, 'credential unchanged when omitted')

  // --- 3. Get/list return public-safe rows and scope by workspace --------
  const fetched = await registry.getExternalSystem({ tenantId: 'tenant_1', workspaceId: null, id: 'sys_1' })
  assert.equal(fetched.id, 'sys_1')
  assert.equal(fetched.hasCredentials, true)
  assert.equal(fetched.credentialFormat, 'enc')
  assert.equal(fetched.credentialsEncrypted, undefined, 'encrypted value is not exposed')

  const listed = await registry.listExternalSystems({ tenantId: 'tenant_1', workspaceId: null, kind: 'erp:k3-wise-webapi' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'sys_1')

  const adapterSystem = await registry.getExternalSystemForAdapter({ tenantId: 'tenant_1', workspaceId: null, id: 'sys_1' })
  assert.equal(adapterSystem.id, 'sys_1')
  assert.deepEqual(adapterSystem.credentials, { username: 'u', password: 'secret' }, 'adapter load decrypts JSON credentials')
  assert.equal(adapterSystem.credentialsEncrypted, undefined, 'adapter load never exposes ciphertext')
  assert.equal(adapterSystem.credentialFingerprint, undefined, 'adapter load omits public fingerprint fields')

  const isolated = await registry.listExternalSystems({ tenantId: 'tenant_1', workspaceId: 'other' })
  assert.equal(isolated.length, 0, 'workspace scope isolates rows')

  // --- 4. Credential clear writes NULL ----------------------------------
  const cleared = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'sys_1',
    name: 'K3 WISE renamed',
    kind: 'erp:k3-wise-webapi',
    role: 'source',
    credentials: null,
  })
  assert.equal(db.rows[0].credentials_encrypted, null, 'credentials null clears stored secret')
  assert.equal(cleared.hasCredentials, false)
  assert.equal(cleared.credentialFormat, null)

  // --- 5. Credential input and format boundaries ------------------------
  for (const invalidCredentials of [123, true, ['token'], new Date('2026-04-24T00:00:00.000Z')]) {
    let badCredentials = null
    try {
      await registry.upsertExternalSystem({
        tenantId: 'tenant_1',
        name: `bad-${typeof invalidCredentials}`,
        kind: 'http',
        credentials: invalidCredentials,
      })
    } catch (error) {
      badCredentials = error
    }
    assert.ok(badCredentials instanceof ExternalSystemValidationError, 'invalid credential shape rejected')
  }

  db.rows.push({
    id: 'sys_unknown',
    tenant_id: 'tenant_1',
    workspace_id: null,
    project_id: null,
    name: 'unknown credential',
    kind: 'http',
    role: 'source',
    config: {},
    capabilities: {},
    status: 'active',
    credentials_encrypted: 'legacy:opaque',
  })
  const unknownCredentialRows = await registry.listExternalSystems({ tenantId: 'tenant_1', workspaceId: null, kind: 'http' })
  assert.equal(unknownCredentialRows[0].credentialFormat, null, 'unknown credential prefixes map to null')
  assert.equal(__internals.detectCredentialFormat('legacy:opaque'), null)

  // --- 6. Not-found and validation errors -------------------------------
  let notFound = null
  try {
    await registry.getExternalSystem({ tenantId: 'tenant_1', id: 'missing' })
  } catch (error) {
    notFound = error
  }
  assert.ok(notFound instanceof ExternalSystemNotFoundError, 'missing row throws not found')

  let badRole = null
  try {
    await registry.upsertExternalSystem({
      tenantId: 'tenant_1',
      name: 'bad',
      kind: 'http',
      role: 'reader',
    })
  } catch (error) {
    badRole = error
  }
  assert.ok(badRole instanceof ExternalSystemValidationError, 'invalid role rejected')

  let badShape = null
  try {
    createExternalSystemRegistry({ db, credentialStore: { encrypt: async () => 'enc:x' } })
  } catch (error) {
    badShape = error
  }
  assert.ok(badShape, 'bad credential store shape rejected')

  const dbWithoutSelect = { ...db }
  delete dbWithoutSelect.select
  let badDb = null
  try {
    createExternalSystemRegistry({ db: dbWithoutSelect, credentialStore })
  } catch (error) {
    badDb = error
  }
  assert.ok(badDb, 'db helper without select rejected')

  const raceDb = createMockDb()
  const raceRegistry = createExternalSystemRegistry({
    db: {
      ...raceDb,
      async updateRow(table, set, where) {
        raceDb.calls.push(['updateRow', table, { ...set }, { ...where }])
        return []
      },
    },
    credentialStore,
    idGenerator: () => 'race_1',
  })
  await raceRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'race',
    kind: 'http',
  })
  let updateRace = null
  try {
    await raceRegistry.upsertExternalSystem({
      tenantId: 'tenant_1',
      id: 'race_1',
      name: 'race',
      kind: 'http',
      status: 'active',
    })
  } catch (error) {
    updateRace = error
  }
  assert.ok(updateRace instanceof ExternalSystemNotFoundError, 'empty update result is not reported as success')

  // --- 7. config/capabilities preserved when not provided on update -------
  const preserveDb = createMockDb()
  const preserveRegistry = createExternalSystemRegistry({
    db: preserveDb,
    credentialStore,
    idGenerator: () => 'sys_preserve',
  })
  await preserveRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'K3 WISE full',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    config: { baseUrl: 'https://k3.internal', acctId: 'ACCT001', orgId: 'ORG1' },
    capabilities: { read: true, write: true, bom: true },
    status: 'active',
  })

  // 7a: status-only update — config and capabilities must be preserved
  const statusOnlyUpdate = await preserveRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_preserve',
    name: 'K3 WISE full',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    status: 'inactive',
    // config and capabilities intentionally omitted
  })
  const storedRow = preserveDb.rows.find((row) => row.id === 'sys_preserve')
  assert.deepEqual(storedRow.config, { baseUrl: 'https://k3.internal', acctId: 'ACCT001', orgId: 'ORG1' },
    'config preserved when not provided on update')
  assert.deepEqual(storedRow.capabilities, { read: true, write: true, bom: true },
    'capabilities preserved when not provided on update')
  assert.equal(statusOnlyUpdate.status, 'inactive', 'status was updated as requested')

  // 7b: explicit config: {} replaces (caller opted in to clearing)
  await preserveRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_preserve',
    name: 'K3 WISE full',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    config: {},
    status: 'inactive',
    // capabilities omitted — should still be preserved
  })
  const afterExplicitEmpty = preserveDb.rows.find((row) => row.id === 'sys_preserve')
  assert.deepEqual(afterExplicitEmpty.config, {}, 'explicit config: {} replaces existing config')
  assert.deepEqual(afterExplicitEmpty.capabilities, { read: true, write: true, bom: true },
    'capabilities still preserved when only config was explicitly cleared')

  // 7c: full config replacement works normally
  await preserveRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_preserve',
    name: 'K3 WISE full',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    config: { baseUrl: 'https://k3-new.internal', acctId: 'ACCT002' },
    capabilities: { read: true, write: false },
    status: 'active',
  })
  const afterFullUpdate = preserveDb.rows.find((row) => row.id === 'sys_preserve')
  assert.deepEqual(afterFullUpdate.config, { baseUrl: 'https://k3-new.internal', acctId: 'ACCT002' },
    'explicit config replacement works')
  assert.deepEqual(afterFullUpdate.capabilities, { read: true, write: false },
    'explicit capabilities replacement works')

  // --- 8. kind/role immutability after creation -------------------------
  const immutableDb = createMockDb()
  const immutableRegistry = createExternalSystemRegistry({
    db: immutableDb,
    credentialStore,
    idGenerator: () => 'sys_imm',
  })
  await immutableRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'immutable-sys',
    kind: 'http',
    role: 'source',
  })

  let kindChanged = null
  try {
    await immutableRegistry.upsertExternalSystem({
      tenantId: 'tenant_1',
      id: 'sys_imm',
      name: 'immutable-sys',
      kind: 'erp:k3-wise-webapi',
      role: 'source',
    })
  } catch (error) {
    kindChanged = error
  }
  assert.ok(kindChanged instanceof ExternalSystemValidationError, 'changing kind after creation is rejected')
  assert.match(kindChanged.message, /kind and role cannot be changed/, 'error message identifies the invariant')
  assert.equal(kindChanged.details.existingKind, 'http', 'details includes original kind')
  assert.equal(kindChanged.details.requestedKind, 'erp:k3-wise-webapi', 'details includes attempted kind')

  let roleChanged = null
  try {
    await immutableRegistry.upsertExternalSystem({
      tenantId: 'tenant_1',
      id: 'sys_imm',
      name: 'immutable-sys',
      kind: 'http',
      role: 'target',
    })
  } catch (error) {
    roleChanged = error
  }
  assert.ok(roleChanged instanceof ExternalSystemValidationError, 'changing role after creation is rejected')
  assert.equal(roleChanged.details.existingRole, 'source', 'details includes original role')
  assert.equal(roleChanged.details.requestedRole, 'target', 'details includes attempted role')

  // Updating other fields with same kind/role succeeds
  const sameKindRole = await immutableRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_imm',
    name: 'immutable-sys renamed',
    kind: 'http',
    role: 'source',
    status: 'inactive',
  })
  assert.equal(sameKindRole.name, 'immutable-sys renamed', 'update with unchanged kind/role succeeds')
  assert.equal(sameKindRole.status, 'inactive', 'status update applied')

  console.log('✓ external-systems: registry + credential boundary tests passed')
}

main().catch((err) => {
  console.error('✗ external-systems FAILED')
  console.error(err)
  process.exit(1)
})
