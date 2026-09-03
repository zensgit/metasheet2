'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createExternalSystemRegistry: createExternalSystemRegistryRaw,
  ExternalSystemConflictError,
  ExternalSystemNotFoundError,
  ExternalSystemValidationError,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'external-systems.cjs'))
const { createConnectionResolver } = require(path.join(__dirname, '..', 'lib', 'connection-resolver.cjs'))

function createExternalSystemRegistry(options = {}) {
  if (options.connectionResolver || !options.dataSourceBinder) {
    return createExternalSystemRegistryRaw(options)
  }
  const binder = options.dataSourceBinder
  return createExternalSystemRegistryRaw({
    ...options,
    connectionResolver: createConnectionResolver({
      facade: {
        async resolveConnectionRegistration(id, context) {
          if (typeof context.principal !== 'string' || context.principal.trim().length === 0) {
            throw new Error('connection binding requires an authenticated principal')
          }
          await binder.assertReferenceable(id, context.principal)
          return {
            id,
            tenantId: context.tenantId,
            type: 'sqlserver',
            scopeKind: 'private',
          }
        },
      },
    }),
  })
}

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
  const pipelineRows = []
  const calls = []

  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    rows,
    pipelineRows,
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
      const tableRows = table === 'integration_pipelines' ? pipelineRows : rows
      const filtered = tableRows.filter(row => matchesWhere(row, options.where || {}))
      return filtered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
    async countRows(table, where) {
      calls.push(['countRows', table, { ...where }])
      const tableRows = table === 'integration_pipelines' ? pipelineRows : rows
      return tableRows.filter(row => matchesWhere(row, where)).length
    },
    async deleteRows(table, where) {
      calls.push(['deleteRows', table, { ...where }])
      const tableRows = table === 'integration_pipelines' ? pipelineRows : rows
      const before = tableRows.length
      for (let index = tableRows.length - 1; index >= 0; index -= 1) {
        if (matchesWhere(tableRows[index], where)) tableRows.splice(index, 1)
      }
      return before - tableRows.length
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

  // --- 4. Public config is redacted while adapter config stays raw -------
  const configDb = createMockDb()
  const configRegistry = createExternalSystemRegistry({
    db: configDb,
    credentialStore,
    idGenerator: () => 'sys_config',
  })
  const publicConfigCreate = await configRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'config-leak-risk',
    kind: 'http',
    role: 'source',
    config: {
      baseUrl: 'https://third-party.example.test',
      accessToken: 'config-access-token',
      headers: {
        Authorization: 'Bearer config-bearer-token',
        'X-Request-Id': 'request-id-header',
      },
      nested: {
        password: 'config-password',
        safeLabel: 'visible',
      },
    },
    credentials: { apiKey: 'credential-secret' },
    status: 'active',
  })
  assert.equal(publicConfigCreate.config.baseUrl, 'https://third-party.example.test')
  assert.equal(publicConfigCreate.config.accessToken, '[redacted]')
  assert.equal(publicConfigCreate.config.headers.Authorization, '[redacted]')
  assert.equal(publicConfigCreate.config.headers['X-Request-Id'], 'request-id-header')
  assert.equal(publicConfigCreate.config.nested.password, '[redacted]')
  assert.equal(publicConfigCreate.config.nested.safeLabel, 'visible')
  assert.equal(publicConfigCreate.credentials, undefined, 'credential payload remains write-only on create')

  const publicConfigList = await configRegistry.listExternalSystems({ tenantId: 'tenant_1' })
  assert.equal(publicConfigList[0].config.accessToken, '[redacted]', 'list redacts public config secrets')
  assert.equal(publicConfigList[0].config.headers.Authorization, '[redacted]', 'list redacts nested public config secrets')

  const publicConfigGet = await configRegistry.getExternalSystem({ tenantId: 'tenant_1', id: 'sys_config' })
  assert.equal(publicConfigGet.config.nested.password, '[redacted]', 'get redacts nested public config secrets')

  const adapterConfigSystem = await configRegistry.getExternalSystemForAdapter({ tenantId: 'tenant_1', id: 'sys_config' })
  assert.equal(adapterConfigSystem.config.accessToken, 'config-access-token', 'adapter receives raw config token')
  assert.equal(adapterConfigSystem.config.headers.Authorization, 'Bearer config-bearer-token',
    'adapter receives raw config authorization header')
  assert.equal(adapterConfigSystem.config.nested.password, 'config-password', 'adapter receives raw nested config password')
  assert.deepEqual(adapterConfigSystem.credentials, { apiKey: 'credential-secret' },
    'adapter credentials still decrypt through private path')

  // --- 4b. SQL lookup-projection identifiers stay on the private adapter load only ---
  const projectionDb = createMockDb()
  // P2-A: a config.dataSourceId binding must be validated against the authenticated principal
  // (owner-only, same as every facade read) and is stamped with the validated owner server-side.
  const projectionBinderCalls = []
  const projectionRegistry = createExternalSystemRegistry({
    db: projectionDb,
    credentialStore,
    idGenerator: () => 'sys_lookup_projection',
    dataSourceBinder: {
      async assertReferenceable(dataSourceId, principal) {
        projectionBinderCalls.push([dataSourceId, principal])
        if (dataSourceId !== 'sql-readonly-1' || principal !== 'owner_1') {
          throw new Error(`Data source with id '${dataSourceId}' not found`)
        }
      },
    },
  })
  const lookupProjection = {
    baseObject: 'dbo.bom_detail',
    lookupObject: 'dbo.part_library',
    localKey: 'part_id',
    foreignKey: 'OBJ_ID',
    fields: { FNumber: 'IdentityNo', FName: 'IdentityName' },
    maxRows: 3,
  }
  const publicProjectionCreate = await projectionRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'private-sql-lookup-projection',
    kind: 'data-source:sql-readonly',
    role: 'source',
    config: { dataSourceId: 'sql-readonly-1', schema: 'dbo', lookupProjection },
    status: 'active',
    principal: 'owner_1',
  })
  assert.equal(publicProjectionCreate.connectionId, 'sql-readonly-1')
  assert.equal(publicProjectionCreate.config.dataSourceId, undefined,
    'a new SQL binding stores the selected Connection only in connection_id')
  assert.equal(publicProjectionCreate.config.dataSourceOwnerId, undefined,
    'canonical bindings do not retain the legacy owner-attribution stamp')
  assert.deepEqual(projectionBinderCalls, [['sql-readonly-1', 'owner_1']],
    'the binder saw exactly the asserted binding')
  assert.equal(publicProjectionCreate.config.schema, 'dbo')
  assert.equal(publicProjectionCreate.config.lookupProjection, undefined,
    'public create response omits the complete private lookup projection')
  const publicProjectionGet = await projectionRegistry.getExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_lookup_projection',
  })
  assert.equal(publicProjectionGet.config.lookupProjection, undefined,
    'public get omits private SQL object/column identifiers')
  const publicProjectionList = await projectionRegistry.listExternalSystems({
    tenantId: 'tenant_1',
    kind: 'data-source:sql-readonly',
  })
  assert.equal(publicProjectionList[0].config.lookupProjection, undefined,
    'public list omits private SQL object/column identifiers')
  const adapterProjectionSystem = await projectionRegistry.getExternalSystemForAdapter({
    tenantId: 'tenant_1',
    id: 'sys_lookup_projection',
    principal: 'owner_1',
    runAs: 'user',
  })
  assert.deepEqual(adapterProjectionSystem.config.lookupProjection, lookupProjection,
    'private adapter load retains the persisted lookup projection exactly')

  // --- 4b-i. R-wave (external review finding 3): the THIRD accessor. The B2a object-scope guard
  // needs to see this private projection — a source configured with one reads a SECOND table — but
  // it must land BEFORE any credential reload, so it may not use the decrypting accessor above.
  const configOnlyProjection = await projectionRegistry.getExternalSystemAdapterConfig({
    tenantId: 'tenant_1',
    id: 'sys_lookup_projection',
  })
  assert.deepEqual(configOnlyProjection.config.lookupProjection, lookupProjection,
    'the non-decrypting accessor sees the private projection the public one strips')
  assert.equal(configOnlyProjection.kind, 'data-source:sql-readonly', 'and the kind the roster keys on')
  assert.deepEqual(Object.keys(configOnlyProjection).sort(), ['config', 'id', 'kind'],
    'and NOTHING else — no credentials, no ciphertext, no fingerprint, no status')
  assert.equal('credentials' in configOnlyProjection, false, 'it never decrypts')
  await assert.rejects(
    () => projectionRegistry.getExternalSystemAdapterConfig({ tenantId: 'tenant_1', id: 'sys_missing' }),
    /external system not found/,
    'a missing system throws rather than resolving to an empty config a guard could read as "no lookup"',
  )
  await projectionRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_lookup_projection',
    name: 'private-sql-lookup-projection-renamed',
    kind: 'data-source:sql-readonly',
    role: 'source',
    config: { dataSourceId: 'sql-readonly-1', schema: 'dbo' },
    status: 'active',
    principal: 'owner_1',
  })
  const preservedProjectionSystem = await projectionRegistry.getExternalSystemForAdapter({
    tenantId: 'tenant_1',
    id: 'sys_lookup_projection',
    principal: 'owner_1',
    runAs: 'user',
  })
  assert.deepEqual(preservedProjectionSystem.config.lookupProjection, lookupProjection,
    'public config round-trip cannot accidentally erase the hidden projection')
  await projectionRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_lookup_projection',
    name: 'private-sql-lookup-projection-renamed',
    kind: 'data-source:sql-readonly',
    role: 'source',
    config: { dataSourceId: 'sql-readonly-1', schema: 'dbo', lookupProjection: null },
    status: 'active',
    principal: 'owner_1',
  })
  const clearedProjectionSystem = await projectionRegistry.getExternalSystemForAdapter({
    tenantId: 'tenant_1',
    id: 'sys_lookup_projection',
    principal: 'owner_1',
    runAs: 'user',
  })
  assert.equal(clearedProjectionSystem.config.lookupProjection, null,
    'trusted-admin explicit null clears the private lookup projection')

  // --- 4c. K3 exact-two acceptance policy is private, persisted adapter configuration ---
  const acceptanceDb = createMockDb()
  const acceptanceRegistry = createExternalSystemRegistry({
    db: acceptanceDb,
    credentialStore,
    idGenerator: () => 'sys_k3_acceptance',
  })
  const c6AcceptancePolicy = { profile: 'k3-test-only-exact-two-add-v1' }
  const publicAcceptanceCreate = await acceptanceRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'private-k3-acceptance',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    config: { baseUrl: 'https://k3.example.invalid', c6AcceptancePolicy },
    status: 'active',
  })
  assert.equal(publicAcceptanceCreate.config.baseUrl, 'https://k3.example.invalid')
  assert.equal(publicAcceptanceCreate.config.c6AcceptancePolicy, undefined,
    'public create response omits the complete K3 acceptance policy')
  const publicAcceptanceGet = await acceptanceRegistry.getExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_k3_acceptance',
  })
  assert.equal(publicAcceptanceGet.config.c6AcceptancePolicy, undefined,
    'public get omits the private K3 acceptance policy')
  const publicAcceptanceList = await acceptanceRegistry.listExternalSystems({
    tenantId: 'tenant_1',
    kind: 'erp:k3-wise-webapi',
  })
  assert.equal(publicAcceptanceList.length, 1)
  assert.equal(publicAcceptanceList[0].config.c6AcceptancePolicy, undefined,
    'public list omits the private K3 acceptance policy')
  const adapterAcceptanceSystem = await acceptanceRegistry.getExternalSystemForAdapter({
    tenantId: 'tenant_1',
    id: 'sys_k3_acceptance',
  })
  assert.deepEqual(adapterAcceptanceSystem.config.c6AcceptancePolicy, c6AcceptancePolicy,
    'private adapter load retains the persisted K3 acceptance policy exactly')
  await acceptanceRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_k3_acceptance',
    name: 'private-k3-acceptance-renamed',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    config: { baseUrl: 'https://k3.example.invalid' },
    status: 'active',
  })
  const preservedAcceptanceSystem = await acceptanceRegistry.getExternalSystemForAdapter({
    tenantId: 'tenant_1',
    id: 'sys_k3_acceptance',
  })
  assert.deepEqual(preservedAcceptanceSystem.config.c6AcceptancePolicy, c6AcceptancePolicy,
    'public config round-trip cannot accidentally erase the hidden K3 acceptance policy')
  await acceptanceRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_k3_acceptance',
    name: 'private-k3-acceptance-renamed',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    config: { baseUrl: 'https://k3.example.invalid', c6AcceptancePolicy: null },
    status: 'active',
  })
  const clearedAcceptanceSystem = await acceptanceRegistry.getExternalSystemForAdapter({
    tenantId: 'tenant_1',
    id: 'sys_k3_acceptance',
  })
  assert.equal(clearedAcceptanceSystem.config.c6AcceptancePolicy, null,
    'trusted-admin explicit null clears the private K3 acceptance policy')

  // --- 5. Credential clear writes NULL ----------------------------------
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

  // --- 6. Credential input and format boundaries ------------------------
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

  // --- 7. Not-found and validation errors -------------------------------
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

  const dbWithoutDelete = { ...db }
  delete dbWithoutDelete.deleteRows
  let badDeleteDb = null
  try {
    createExternalSystemRegistry({ db: dbWithoutDelete, credentialStore })
  } catch (error) {
    badDeleteDb = error
  }
  assert.ok(badDeleteDb, 'db helper without deleteRows rejected')

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

  // --- 8. config/capabilities preserved when not provided on update -------
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

  // 7a: config-only update — omitted status/role must be preserved on update, and the supplied
  // config is a PATCH: the two keys it names are updated, `orgId` (which it never mentions) rides
  // through. Before the bridge lossy-save fix this dropped orgId.
  await preserveRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_preserve',
    name: 'K3 WISE full',
    kind: 'erp:k3-wise-webapi',
    config: { baseUrl: 'https://k3-config-only.internal', acctId: 'ACCT-CONFIG' },
    // role/status intentionally omitted
  })
  const afterConfigOnlyUpdate = preserveDb.rows.find((row) => row.id === 'sys_preserve')
  assert.equal(afterConfigOnlyUpdate.role, 'target', 'omitted role preserves existing target role')
  assert.equal(afterConfigOnlyUpdate.status, 'active', 'omitted status preserves existing active status')
  assert.deepEqual(afterConfigOnlyUpdate.config,
    { baseUrl: 'https://k3-config-only.internal', acctId: 'ACCT-CONFIG', orgId: 'ORG1' },
    'named config keys are updated and unnamed stored keys are preserved')

  // 7b: status-only update — config and capabilities must be preserved
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
  assert.deepEqual(storedRow.config,
    { baseUrl: 'https://k3-config-only.internal', acctId: 'ACCT-CONFIG', orgId: 'ORG1' },
    'config preserved when not provided on update')
  assert.deepEqual(storedRow.capabilities, { read: true, write: true, bom: true },
    'capabilities preserved when not provided on update')
  assert.equal(statusOnlyUpdate.status, 'inactive', 'status was updated as requested')

  // 7c: explicit config: {} is an EMPTY PATCH, not a wipe. An edit form that serializes fewer keys
  // than the record stores (the data-source bridge picker is exactly that) must not be able to
  // destroy stored config by omission — including the degenerate omit-everything case. Clearing one
  // key stays possible, and stays explicit: `{ key: null }`.
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
  assert.deepEqual(afterExplicitEmpty.config,
    { baseUrl: 'https://k3-config-only.internal', acctId: 'ACCT-CONFIG', orgId: 'ORG1' },
    'explicit config: {} names no key, so it clears none')
  assert.deepEqual(afterExplicitEmpty.capabilities, { read: true, write: true, bom: true },
    'capabilities still preserved when config carried no keys')

  // 7c-bis: an explicit null is the one way to clear a config key through this path.
  await preserveRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_preserve',
    name: 'K3 WISE full',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    config: { orgId: null },
    status: 'inactive',
  })
  const afterExplicitNull = preserveDb.rows.find((row) => row.id === 'sys_preserve')
  assert.equal(afterExplicitNull.config.orgId, null, 'an explicit null clears the key it names')
  assert.equal(afterExplicitNull.config.baseUrl, 'https://k3-config-only.internal',
    'and clears nothing it does not name')

  // 7d: named keys are replaced normally
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
  assert.equal(afterFullUpdate.config.baseUrl, 'https://k3-new.internal', 'explicit config value replaces')
  assert.equal(afterFullUpdate.config.acctId, 'ACCT002', 'explicit config value replaces')
  assert.deepEqual(afterFullUpdate.capabilities, { read: true, write: false },
    'explicit capabilities replacement works')

  // 7e: O4 probe for #1821 — nested config.objects.material.schema (incl. each
  //     field's reference.identifier) must survive upsert -> store -> get.
  //     A config-level sensitive key is included to prove the get/public
  //     projection's sanitize is ACTIVE on this path (so schema survival is not
  //     a no-op sanitize), while the non-sensitive reference schema is spared.
  const refSchema = [
    { name: 'FBaseUnitID', type: 'reference', reference: { identifier: 'FNumber' } },
    { name: 'FAcctID', type: 'reference', reference: { identifier: 'FID' } },
  ]
  await preserveRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_preserve',
    name: 'K3 WISE full',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    status: 'active',
    config: {
      baseUrl: 'https://k3-ref.internal',
      apiKey: 'should-be-redacted-not-a-real-secret',
      objects: { material: { schema: refSchema } },
    },
  })
  const storedRefRow = preserveDb.rows.find((row) => row.id === 'sys_preserve')
  assert.deepEqual(storedRefRow.config.objects.material.schema, refSchema,
    'O4: nested objects.material.schema (incl. per-field reference.identifier) stored verbatim')
  const fetchedRef = await preserveRegistry.getExternalSystem({
    tenantId: 'tenant_1', workspaceId: null, id: 'sys_preserve',
  })
  // sanitize rebuilds nested objects with a null prototype (its prototype-pollution
  // guard), so compare JSON-normalized content — which is exactly what gets persisted
  // (JSONB) and sent on the wire.
  assert.deepEqual(JSON.parse(JSON.stringify(fetchedRef.config.objects.material.schema)), refSchema,
    'O4: schema + reference.identifier content survives the get/public projection (sanitize does not strip it)')
  assert.equal(fetchedRef.config.apiKey, '[redacted]',
    'O4: config sanitize is active here (sensitive key redacted) — schema survival is not a no-op')

  // --- 9. kind/role immutability after creation -------------------------
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

  // --- 10. delete protects referenced systems and returns public shape ----
  const deleteDb = createMockDb()
  const deleteRegistry = createExternalSystemRegistry({
    db: deleteDb,
    credentialStore,
    idGenerator: () => 'sys_delete',
  })
  await deleteRegistry.upsertExternalSystem({
    tenantId: 'tenant_1',
    workspaceId: null,
    name: 'delete-me',
    kind: 'http',
    role: 'source',
    credentials: { token: 'delete-secret' },
  })
  deleteDb.pipelineRows.push({
    id: 'pipe_source',
    tenant_id: 'tenant_1',
    workspace_id: null,
    source_system_id: 'sys_delete',
    target_system_id: 'target_1',
  })
  deleteDb.pipelineRows.push({
    id: 'pipe_other_workspace',
    tenant_id: 'tenant_1',
    workspace_id: 'other',
    source_system_id: 'sys_delete',
    target_system_id: 'target_1',
  })

  let deleteConflict = null
  try {
    await deleteRegistry.deleteExternalSystem({
      tenantId: 'tenant_1',
      workspaceId: null,
      id: 'sys_delete',
    })
  } catch (error) {
    deleteConflict = error
  }
  assert.ok(deleteConflict instanceof ExternalSystemConflictError, 'referenced external system cannot be deleted')
  assert.equal(deleteConflict.details.referencedPipelineCount, 1, 'conflict counts only matching tenant/workspace references')
  assert.equal(deleteConflict.details.sourcePipelineCount, 1)
  assert.equal(deleteConflict.details.targetPipelineCount, 0)
  assert.equal(deleteDb.rows.length, 1, 'conflict does not delete the system')

  deleteDb.pipelineRows.length = 0
  const deleteResult = await deleteRegistry.deleteExternalSystem({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'sys_delete',
  })
  assert.equal(deleteResult.deleted, true)
  assert.equal(deleteResult.system.id, 'sys_delete')
  assert.equal(deleteResult.system.credentials, undefined, 'deleted public system does not expose credentials')
  assert.equal(deleteDb.rows.length, 0, 'unused external system is removed')

  let deleteMissing = null
  try {
    await deleteRegistry.deleteExternalSystem({
      tenantId: 'tenant_1',
      workspaceId: null,
      id: 'sys_delete',
    })
  } catch (error) {
    deleteMissing = error
  }
  assert.ok(deleteMissing instanceof ExternalSystemNotFoundError, 'deleting missing external system reports not found')

  await testInstanceDigestIsProductionBehaviour()
  await testDataSourceBindingValidation()
  await testBridgeEditPreservesFullConfig()

  console.log('✓ external-systems: registry + credential boundary tests passed')
}

main().catch((err) => {
  console.error('✗ external-systems FAILED')
  console.error(err)
  process.exit(1)
})

// ---------------------------------------------------------------------------------------------
// REVIEW P1-1 — the PRODUCTION digest function had ZERO executing coverage.
//
// Replacing getExternalSystemInstanceDigest with a constant — which reinstates the owner's exact
// defect, every record certifying every other — left the full 157-file chain at exit 0. So did
// deleting acctId from the material, i.e. reverting to origin-only identity. Both "covering"
// suites re-implement the digest in their own fixtures with their own keys: the very
// fixture-vs-production divergence this fix's comments blame for the original defect.
//
// These tests call the REAL function through a REAL registry.
// ---------------------------------------------------------------------------------------------
async function testInstanceDigestIsProductionBehaviour() {
  const { createExternalSystemRegistry } = require('../lib/external-systems.cjs')

  // The SAME fixtures the rest of this file uses, so the registry is constructed exactly as the
  // other tests construct it — a bespoke stub here would be one more fixture that diverges.
  const db = createMockDb()
  const credentialStore = createMockCredentialStore()
  const registry = createExternalSystemRegistry({ db, credentialStore, idGenerator: () => 'unused' })

  const put = async (id, kind, baseUrl, credentials, extraConfig = {}) => {
    await registry.upsertExternalSystem({
      tenantId: 't1', workspaceId: null, id, kind, name: id, role: 'target', status: 'active',
      config: { baseUrl, ...extraConfig }, credentials,
    })
  }
  const digest = (id) => registry.getExternalSystemInstanceDigest({ id, tenantId: 't1', workspaceId: null })

  const K3 = 'erp:k3-wise-webapi'
  await put('a', K3, 'https://k3.example.test', { username: 'u', password: 'p', acctId: '001' })
  await put('b', K3, 'https://k3.example.test', { username: 'u', password: 'p', acctId: '002' })
  await put('a2', K3, 'https://k3.example.test/OTHER-PATH', { username: 'u', password: 'ROTATED', acctId: '001' })
  await put('c', K3, 'https://k3-other.example.test', { username: 'u', password: 'p', acctId: '001' })
  await put('d', 'plm:yuantus-wrapper', 'https://k3.example.test', { username: 'u', password: 'p', acctId: '001' })
  await put('e', K3, 'https://k3.example.test', { username: 'u', password: 'p' })
  await put('f', K3, 'not-a-url', { username: 'u', password: 'p', acctId: '001' })
  await put('url-only', K3, undefined, { username: 'u', password: 'p', acctId: '001' }, {
    url: 'https://k3.example.test/URL-ALIAS-PATH',
  })
  await put('base-url-wins', K3, 'https://k3.example.test/BASE-PATH', {
    username: 'u', password: 'p', acctId: '001',
  }, {
    url: 'https://k3-other.example.test/IGNORED-PATH',
  })

  const [dA, dB, dA2, dC, dD, dE, dF] = await Promise.all(
    ['a', 'b', 'a2', 'c', 'd', 'e', 'f'].map(digest))

  // THE OWNER'S DEFECT: same host, different account set.
  assert.notEqual(dA, dB, 'same origin + DIFFERENT acctId must NOT digest equal — this is the ruling')
  // Same account set, different path, PASSWORD ROTATED — a real rotation, not a reused object.
  assert.equal(dA, dA2, 'same host + same account set must survive a password rotation and a path change')
  assert.notEqual(dA, dC, 'different origin must not digest equal')
  assert.notEqual(dA, dD, 'kind participates: a non-K3 record must not digest equal')
  // FAIL-CLOSED.
  assert.equal(dE, null, 'no authenticatable acctId must yield null, not a digest')
  assert.equal(dF, null, 'an unparseable baseUrl must yield null, not a digest')
  assert.equal(await digest('missing'), null, 'an unknown system must yield null')
  assert.equal(await digest('url-only'), dA,
    'config.url must identify the same instance when config.baseUrl is absent, matching the adapter alias')
  assert.equal(await digest('base-url-wins'), dA,
    'config.baseUrl must win when both baseUrl and url are present, matching adapter || precedence')

  // The digest must not carry the account set in recoverable form: an unkeyed hash of the
  // material would be trivially brute-forced (the review recovered "001" in milliseconds).
  const naive = require('node:crypto').createHash('sha256')
    .update([K3, 'https://k3.example.test', '001'].map((p) => `${p.length}:${p}`).join('|')).digest('hex')
  assert.notEqual(dA, naive, 'the digest must be KEYED — an unkeyed hash of the material is reversible')

  // P2-1: selection order must match the adapter's firstDefined (first DEFINED, not first STRING).
  await put('g', K3, 'https://k3.example.test', { username: 'u', password: 'p', acctId: 1001, accountSet: '002' })
  await put('h', K3, 'https://k3.example.test', { username: 'u', password: 'p', acctId: '002' })
  assert.notEqual(await digest('g'), await digest('h'),
    'a numeric acctId must select as 1001 (what login uses), not fall through to accountSet 002')

  // REVIEW P1-2 — AUTHORITY-CODE MODE. The adapter authenticates with authorityCode and NEVER
  // sends acctId in that mode. Digesting acctId unconditionally had two failures, both pinned here.
  const AC = 'erp:k3-wise-webapi'
  await put('ac1', AC, 'https://k3.example.test', { authorityCode: 'AC-ONE' })
  await put('ac2', AC, 'https://k3.example.test', { authorityCode: 'AC-TWO' })
  // (a) the owner's defect, in this mode: different authority codes, SAME stale acctId.
  await put('ac3', AC, 'https://k3.example.test', { authorityCode: 'AC-ONE', acctId: 'STALE' })
  await put('ac4', AC, 'https://k3.example.test', { authorityCode: 'AC-TWO', acctId: 'STALE' })
  const [dAc1, dAc2, dAc3, dAc4] = await Promise.all(['ac1', 'ac2', 'ac3', 'ac4'].map(digest))

  // (b) a clean authority-code record must be DIGESTIBLE. It used to be null, which made the C6
  // write gate UNSATISFIABLE — a block main did not have, and one that would have surfaced inside
  // the non-retryable customer window.
  assert.ok(dAc1, 'an authority-code record must yield a digest, not null')
  assert.notEqual(dAc1, dAc2, 'different authority codes are different instances')
  assert.notEqual(dAc3, dAc4,
    'different authority codes must differ even when a STALE acctId is identical — digesting acctId '
    + 'in this mode named a field login never sends')
  // The mode determines which identity is digested, so acctId must not leak into it.
  assert.equal(dAc1, dAc3, 'a stale acctId must not change the identity in authority-code mode')

  // REVIEW P2-1 (third round) — sessionId is the adapter's FIRST auth branch and the digest
  // started at its second, so both of P1-2's failure directions were alive one mode over.
  await put('s1', AC, 'https://k3.example.test', { sessionId: 'SESS-ONE', acctId: 'STALE' })
  await put('s2', AC, 'https://k3.example.test', { sessionId: 'SESS-TWO', acctId: 'STALE' })
  await put('s3', AC, 'https://k3.example.test', { sessionId: 'SESS-ONE' })
  const [dS1, dS2, dS3] = await Promise.all(['s1', 's2', 's3'].map(digest))
  assert.notEqual(dS1, dS2,
    'different sessionId must differ EVEN WITH an identical stale acctId — session auth never '
    + 'sends acctId, so digesting it named a field login does not use')
  assert.ok(dS3, 'a session-only record must be digestible, not null — null makes the write gate unsatisfiable')
  assert.equal(dS1, dS3, 'a stale acctId must not change the identity in session mode')

  // P1-2 (review r3): the three cases above all use a STRING sessionId, so they prove the branch
  // EXISTS but constrain its boundary in neither direction — replacing the guard with the correct
  // one left them green. These pin the boundary, which is where the regression lived.
  await put('sf1', AC, 'https://k3.example.test', { sessionId: 0, acctId: '001' })
  await put('sf2', AC, 'https://k3.example.test', { sessionId: 0, acctId: '002' })
  await put('sf3', AC, 'https://k3.example.test', { sessionId: false })
  const [dSf1, dSf2, dSf3] = await Promise.all(['sf1', 'sf2', 'sf3'].map(digest))
  // Shape first: notEqual alone passes when one side is null and the other is not, which would be
  // a different failure wearing this assertion's clothes.
  assert.match(String(dSf1), /^[0-9a-f]{64}$/, 'falsy sessionId + acctId must still digest')
  assert.match(String(dSf2), /^[0-9a-f]{64}$/, 'falsy sessionId + acctId must still digest')
  assert.notEqual(dSf1, dSf2,
    'a FALSY sessionId is not a session: the adapter falls through to acctId, so 001 and 002 are '
    + 'different instances — a superset guard made them EQUAL, reinstating the wrong-账套 defect')
  assert.equal(dSf3, null,
    'falsy sessionId with no acctId must be UNVERIFIABLE — the adapter throws CREDENTIALS_MISSING, '
    + 'so a satisfiable gate here would certify a write that cannot authenticate')

  // P3-1: config.authMode is load-bearing (same wrong-账套 class) and had zero coverage — the
  // assertion-less case removed earlier should have been REPLACED, not just deleted.
  await put('am1', AC, 'https://k3.example.test', { authorityCode: 'AC-X', acctId: '111' }, { authMode: 'login' })
  await put('am2', AC, 'https://k3.example.test', { authorityCode: 'AC-X', acctId: '222' }, { authMode: 'login' })
  assert.notEqual(await digest('am1'), await digest('am2'),
    'an explicit config.authMode=login must select acctId even when an authorityCode is present — '
    + 'dropping cfg.authMode from the resolution digests the wrong identity')

  // P2-1 (review r4): the adapter accepts THREE mode strings — 'authority-code', 'authorityCode'
  // and 'token'. Only the first was exercised, and narrowing the guard to just it left the suite
  // green. The untested branch carries THIS PR's own defect: under authMode:'token' both records
  // fall to the else branch and digest acctId=001, so two different authority codes certify as the
  // same instance — the wrong-账套 defect, one authMode value over.
  for (const mode of ['authorityCode', 'token']) {
    await put(`tk1_${mode}`, AC, 'https://k3.example.test', { authorityCode: 'AC-1', acctId: '001' }, { authMode: mode })
    await put(`tk2_${mode}`, AC, 'https://k3.example.test', { authorityCode: 'AC-2', acctId: '001' }, { authMode: mode })
    const [t1, t2] = await Promise.all([digest(`tk1_${mode}`), digest(`tk2_${mode}`)])
    assert.match(String(t1), /^[0-9a-f]{64}$/, `authMode '${mode}' must digest, not fail closed`)
    assert.notEqual(t1, t2,
      `authMode '${mode}' authenticates with authorityCode, so different codes are different `
      + 'instances even when acctId is identical')
  }

  // P3-1: every session case above is FALSY, so narrowing the guard to `typeof === 'string'` left
  // the suite green. A truthy NON-STRING sessionId must still be a session (the adapter's guard is
  // bare truthiness), which means acctId must NOT decide.
  await put('sn1', AC, 'https://k3.example.test', { sessionId: 12345, acctId: '001' })
  await put('sn2', AC, 'https://k3.example.test', { sessionId: 12345, acctId: '002' })
  assert.equal(await digest('sn1'), await digest('sn2'),
    'a truthy non-string sessionId is still a session: acctId must not change the identity')

  // NIT (review r2): the per-process key had NO coverage — replacing randomBytes with a constant
  // left the suite green. Two registries in one process must agree; a digest must not be
  // reproducible from the material alone by anyone who knows the scheme.
  const otherRegistry = createExternalSystemRegistry({ db, credentialStore, idGenerator: () => 'unused2' })
  assert.equal(
    await otherRegistry.getExternalSystemInstanceDigest({ id: 'a', tenantId: 't1', workspaceId: null }),
    dA, 'two registries in ONE process must produce the same digest (the key is per-process)')

  // ...but same-process agreement does NOT discriminate: a HARDCODED key satisfies it too, and the
  // first version of this check passed against exactly that mutation. The property that separates
  // "per-process random" from "constant in source" is that a DIFFERENT PROCESS must disagree.
  // Measured, not argued.
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
    const { createExternalSystemRegistry } = require(${JSON.stringify(require.resolve('../lib/external-systems.cjs'))})
    const row = { id: 'a', tenant_id: 't1', workspace_id: null, kind: 'erp:k3-wise-webapi', name: 'a',
      role: 'target', status: 'active', config: { baseUrl: 'https://k3.example.test' },
      credentials_encrypted: JSON.stringify({ username: 'u', password: 'p', acctId: '001' }) }
    const db = { async selectOne() { return row }, async insertRow() {}, async updateRow() {},
      async insertOne() {}, async select() { return [] },
      async deleteRows() {}, async countRows() { return 0 } }
    const cs = { async encrypt(v) { return v }, async decrypt(v) { return v }, async fingerprint() { return 'x' } }
    createExternalSystemRegistry({ db, credentialStore: cs })
      .getExternalSystemInstanceDigest({ id: 'a', tenantId: 't1', workspaceId: null })
      .then((d) => process.stdout.write(String(d)))
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, `child probe must run: ${child.stderr}`)
  // NIT: a drifted stub makes the child print "null" and exit 0 — status===0, length>0 and
  // notEqual("null", dA) would ALL pass, and the probe would prove nothing.
  assert.match(child.stdout, /^[0-9a-f]{64}$/,
    `child probe must emit a real digest, got: ${JSON.stringify(child.stdout)}`)
  assert.notEqual(child.stdout, dA,
    'a DIFFERENT PROCESS must produce a different digest — otherwise the key is a constant in '
    + 'source and the digest is reproducible by anyone who reads the repo')

  console.log('  external-systems: instance digest (production function) OK')
}

// ---------------------------------------------------------------------------------------------
// P2-A — config.dataSourceId is a persisted reference into the CORE data_sources table, and it
// used to persist with no existence/ownership check: any integration:write holder in any tenant
// could pin a foreign user's source id (making it un-deletable by its owner once the core
// referential delete guard counts references). The registry now validates the binding against the
// authenticated principal through the host facade and stamps config.dataSourceOwnerId
// server-side; the core guard counts ONLY owner-attributed rows.
// ---------------------------------------------------------------------------------------------
async function testDataSourceBindingValidation() {
  const credentialStore = createMockCredentialStore()

  // fail CLOSED without a wired binder
  const binderlessRegistry = createExternalSystemRegistry({
    db: createMockDb(),
    credentialStore,
    idGenerator: () => 'sys_bind_closed',
  })
  await assert.rejects(
    () => binderlessRegistry.upsertExternalSystem({
      tenantId: 'tenant_1',
      name: 'bind-closed',
      kind: 'data-source:sql-readonly',
      role: 'source',
      config: { dataSourceId: 'ds-1' },
      principal: 'owner_1',
    }),
    (err) => err instanceof ExternalSystemValidationError && /resolution/.test(err.message),
    'a canonical SQL binding with no wired resolver is refused (fail closed), never silently persisted',
  )

  const binderCalls = []
  const binder = {
    async assertReferenceable(dataSourceId, principal) {
      binderCalls.push([dataSourceId, principal])
      if (dataSourceId !== 'ds-owned' || principal !== 'owner_1') {
        throw new Error(`Data source with id '${dataSourceId}' not found`)
      }
    },
  }
  const db = createMockDb()
  let nextId = 0
  const registry = createExternalSystemRegistry({
    db,
    credentialStore,
    idGenerator: () => `sys_bind_${nextId += 1}`,
    dataSourceBinder: binder,
  })

  const encryptCallsBeforeForbiddenCredential = credentialStore.calls.filter(([name]) => name === 'encrypt').length
  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_1',
      name: 'binding-must-not-own-credentials',
      kind: 'data-source:sql-readonly',
      role: 'source',
      connectionId: 'ds-owned',
      config: { schema: 'dbo' },
      credentials: { password: 'duplicate-secret' },
      principal: 'owner_1',
    }),
    (err) => err instanceof ExternalSystemValidationError
      && err.details.code === 'CONNECTION_BINDING_CREDENTIALS_FORBIDDEN',
    'a SQL Binding cannot create a second executable credential document',
  )
  assert.equal(
    credentialStore.calls.filter(([name]) => name === 'encrypt').length,
    encryptCallsBeforeForbiddenCredential,
    'forbidden Binding credentials are rejected before encryption',
  )

  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_1',
      name: 'missing-canonical-connection',
      kind: 'data-source:sql-readonly',
      role: 'source',
      config: { schema: 'dbo' },
      principal: 'owner_1',
    }),
    (err) => err instanceof ExternalSystemValidationError
      && err.details.field === 'connectionId'
      && /required/.test(err.message),
    'a new SQL readonly binding cannot be persisted without a canonical Connection',
  )

  // fail CLOSED without an authenticated principal
  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_1',
      name: 'bind-no-principal',
      kind: 'data-source:sql-readonly',
      role: 'source',
      config: { dataSourceId: 'ds-owned' },
    }),
    (err) => err instanceof ExternalSystemValidationError
      && err.details.code === 'CONNECTION_CANONICAL_UNAVAILABLE',
    'a canonical binding without an authenticated principal is refused without an identity leak',
  )
  assert.equal(binderCalls.length, 0, 'the binder is never consulted without a principal')

  // a non-owner principal is refused with the facade's uniform wording, and nothing persists
  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_1',
      name: 'bind-not-yours',
      kind: 'data-source:sql-readonly',
      role: 'source',
      config: { dataSourceId: 'ds-owned' },
      principal: 'stranger_9',
    }),
    (err) => err instanceof ExternalSystemValidationError
      && err.details.code === 'CONNECTION_CANONICAL_UNAVAILABLE',
    'a non-owner canonical bind is refused with a values-free error and does not persist',
  )
  assert.equal(db.rows.length, 0, 'a refused bind leaves no row behind')

  // a client-forged attribution stamp is discarded when no binding is asserted...
  const unbound = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'bind-forged-stamp-only',
    kind: 'http',
    role: 'source',
    config: { baseUrl: 'https://example.test', dataSourceOwnerId: 'victim_7' },
  })
  assert.equal(unbound.config.dataSourceOwnerId, undefined,
    'dataSourceOwnerId is server-owned metadata: a client-sent stamp without a binding is stripped')

  // ...and discarded when the selected Connection is persisted canonically.
  const bound = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    name: 'bind-owned',
    kind: 'data-source:sql-readonly',
    role: 'source',
    config: { dataSourceId: 'ds-owned', schema: 'dbo', dataSourceOwnerId: 'victim_7' },
    principal: 'owner_1',
  })
  assert.equal(bound.connectionId, 'ds-owned')
  assert.equal(bound.config.dataSourceId, undefined)
  assert.equal(bound.config.dataSourceOwnerId, undefined,
    'canonical storage keeps neither the client pointer nor its legacy attribution stamp')
  const boundRow = db.rows.find((row) => row.id === bound.id)
  assert.equal(boundRow.connection_id, 'ds-owned')
  assert.equal(boundRow.legacy_connection_fallback_eligible, false,
    'post-cutover rows can never gain legacy fallback implicitly')

  // Even if a migrated row retains dormant ciphertext, SQL adapter loading
  // resolves only the canonical Connection and never decrypts the Binding copy.
  boundRow.credentials_encrypted = `enc:${Buffer.from(JSON.stringify({ password: 'dormant-copy' })).toString('base64')}`
  const decryptCallsBeforeCanonicalLoad = credentialStore.calls.filter(([name]) => name === 'decrypt').length
  const canonicalAdapterSystem = await registry.getExternalSystemForAdapter({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: bound.id,
    principal: 'owner_1',
    runAs: 'user',
  })
  assert.equal(canonicalAdapterSystem.config.dataSourceId, 'ds-owned')
  assert.equal(canonicalAdapterSystem.credentials, undefined)
  assert.equal(
    credentialStore.calls.filter(([name]) => name === 'decrypt').length,
    decryptCallsBeforeCanonicalLoad,
    'SQL adapter loading never decrypts credentials_encrypted from the Binding row',
  )
  const sealedFacadeCalls = []
  const sealedRegistry = createExternalSystemRegistryRaw({
    db,
    credentialStore,
    connectionResolver: createConnectionResolver({
      facade: {
        async resolveConnectionRegistration(id) {
          return { id, tenantId: 'tenant_1', type: 'sqlserver', scopeKind: 'private' }
        },
      },
      sealedSnapshotFacade: {
        async resolveSqlServerConnection(id, input) {
          sealedFacadeCalls.push({ id, input })
          return {
            connection: { database: 'sealed_db' },
            credentials: { password: 'sealed-secret', user: 'sealed-user' },
          }
        },
      },
    }),
  })
  const ordinarySqlAdapter = await sealedRegistry.getExternalSystemForAdapter({
    tenantId: 'tenant_1', workspaceId: null, id: bound.id, principal: 'owner_1', runAs: 'user',
  })
  assert.equal(ordinarySqlAdapter.credentials, undefined,
    'ordinary SQL adapter access never receives the sealed projection')
  assert.equal(ordinarySqlAdapter.config.sealedSnapshotSqlServer, undefined)
  const sealedSqlAdapter = await sealedRegistry.getExternalSystemForSealedSnapshot({
    tenantId: 'tenant_1', workspaceId: null, id: bound.id, principal: 'owner_1', runAs: 'user',
  })
  assert.deepEqual(sealedSqlAdapter.config.sealedSnapshotSqlServer, { database: 'sealed_db' })
  assert.deepEqual(sealedSqlAdapter.credentials, {
    sealedSnapshotSqlServer: { password: 'sealed-secret', user: 'sealed-user' },
  })
  assert.deepEqual(sealedFacadeCalls, [{
    id: 'ds-owned',
    input: { tenantId: 'tenant_1', workspaceId: null, principal: 'owner_1', runAs: 'user' },
  }])
  boundRow.credentials_encrypted = null

  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_1',
      name: 'mismatched-dual-reference',
      kind: 'data-source:sql-readonly',
      role: 'source',
      connectionId: 'ds-owned',
      config: { dataSourceId: 'other-ds' },
      principal: 'owner_1',
    }),
    (err) => err instanceof ExternalSystemValidationError
      && err.details.code === 'CONNECTION_BINDING_MISMATCH',
    'canonical and retained legacy references that disagree fail closed',
  )

  // a config-preserving update (the test-result persist path) re-validates nothing and
  // needs no principal: the stored, already-validated binding rides through untouched.
  const preserved = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: bound.id,
    name: 'bind-owned',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'error',
    lastError: 'connection test failed',
  })
  assert.equal(preserved.connectionId, 'ds-owned', 'preserved update keeps the canonical binding')
  assert.equal(preserved.config.schema, 'dbo', 'preserved update keeps semantic config')

  console.log('  external-systems: dataSourceId bind-time validation OK')
}

// ---------------------------------------------------------------------------------------------
// BRIDGE LOSSY SAVE — editing a data-source bridge connection dropped stored config keys.
//
// The bridge edit form does not render the whole config: it rebuilds `config` from the two fields
// it owns (`dataSourceId` + `object`) and PUTs that. The registry replaced config wholesale, so
// every stored key the form does not render was destroyed by a rename — most damagingly
// `config.schema`, the connection's default SQL schema, which the readonly source adapter reads to
// list objects and to qualify a bare object name. The connection kept working just differently:
// reads silently retargeted to the server's default schema.
//
// These tests drive the REAL registry. Reverting patchConfig back to a wholesale replace reds them.
// ---------------------------------------------------------------------------------------------
async function testBridgeEditPreservesFullConfig() {
  const credentialStore = createMockCredentialStore()
  const binderCalls = []
  const db = createMockDb()
  const registry = createExternalSystemRegistry({
    db,
    credentialStore,
    idGenerator: () => 'sys_bridge',
    dataSourceBinder: {
      async assertReferenceable(dataSourceId, principal) {
        binderCalls.push([dataSourceId, principal])
        if (principal !== 'owner_1') throw new Error(`Data source with id '${dataSourceId}' not found`)
      },
    },
  })

  const lookupProjection = { table: 'dbo.t_Unit', keyColumn: 'FItemID', valueColumn: 'FName' }
  // Simulate a migration-backfilled row whose canonical id was deliberately nulled during the
  // rollback window. The durable marker makes this the one shape allowed to keep exercising the
  // legacy config.dataSourceId PATCH semantics below.
  db.rows.push({
    id: 'sys_bridge',
    tenant_id: 'tenant_1',
    workspace_id: null,
    project_id: null,
    name: 'SQL bridge',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: { dataSourceId: 'ds-1', object: 'dbo.t_ICItem', schema: 'dbo', pageSize: 500, lookupProjection },
    capabilities: {},
    credentials_encrypted: null,
    connection_id: null,
    legacy_connection_fallback_eligible: true,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
  })
  db.rows[0].config.dataSourceOwnerId = 'owner_1'
  const created = db.rows.find((row) => row.id === 'sys_bridge')
  assert.equal(created.config.schema, 'dbo', 'precondition: the created bridge stores a schema')
  assert.equal(created.config.dataSourceOwnerId, 'owner_1', 'precondition: the binding is stamped')

  // 1. The exact payload the bridge picker serializes on a rename: pointer + object, nothing else.
  await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_bridge',
    name: 'SQL bridge renamed',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    principal: 'owner_1',
    config: { dataSourceId: 'ds-1', object: 'dbo.t_ICItem' },
  })
  const renamed = db.rows.find((row) => row.id === 'sys_bridge')
  assert.equal(renamed.name, 'SQL bridge renamed', 'the rename landed')
  assert.equal(renamed.config.schema, 'dbo',
    'a bridge edit that does not render config.schema must not drop it')
  assert.equal(renamed.config.pageSize, 500, 'nor any other stored key the form does not render')
  assert.deepEqual(renamed.config.lookupProjection, lookupProjection, 'nor the private projection')
  assert.equal(renamed.config.dataSourceOwnerId, 'owner_1', 'the stamp is still the validated owner')

  // 2. A payload that does not re-assert the pointer keeps BOTH the pointer and its stamp — and
  //    consults no binder, exactly like an update that omits `config` entirely.
  const binderCallsBefore = binderCalls.length
  await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_bridge',
    name: 'SQL bridge renamed twice',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    principal: 'owner_1',
    config: { object: 'dbo.t_ICItemCore' },
  })
  const pointerless = db.rows.find((row) => row.id === 'sys_bridge')
  assert.equal(pointerless.config.object, 'dbo.t_ICItemCore', 'the key the payload names is updated')
  assert.equal(pointerless.config.dataSourceId, 'ds-1',
    'an edit that omits the pointer must not silently unbind the connection')
  assert.equal(pointerless.config.dataSourceOwnerId, 'owner_1',
    'and must not drop the server stamp the core delete guard counts')
  assert.equal(binderCalls.length, binderCallsBefore,
    'a payload that asserts no binding re-validates nothing')

  // 3. dataSourceOwnerId stays server-owned. A stranger patching one unrelated key cannot
  //    re-attribute the stored pin to themselves by smuggling a stamp into the payload.
  await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_bridge',
    name: 'SQL bridge renamed twice',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    principal: 'stranger_9',
    config: { pageSize: 250, dataSourceOwnerId: 'stranger_9' },
  })
  const forged = db.rows.find((row) => row.id === 'sys_bridge')
  assert.equal(forged.config.pageSize, 250, 'the legitimate part of the patch landed')
  assert.equal(forged.config.dataSourceOwnerId, 'owner_1',
    'a client-sent stamp cannot overwrite the stored server-stamped attribution')

  // 4. Changing the pointer STILL validates against the authenticated principal.
  await assert.rejects(
    () => registry.upsertExternalSystem({
      tenantId: 'tenant_1',
      id: 'sys_bridge',
      name: 'SQL bridge repointed',
      kind: 'data-source:sql-readonly',
      role: 'source',
      status: 'active',
      principal: 'stranger_9',
      config: { dataSourceId: 'ds-2' },
    }),
    (err) => err instanceof ExternalSystemValidationError && /not found/.test(err.message),
    'a payload that DOES assert a pointer is validated against the principal, as before',
  )
  const unchanged = db.rows.find((row) => row.id === 'sys_bridge')
  assert.equal(unchanged.config.dataSourceId, 'ds-1', 'the refused repoint left the stored pointer alone')

  const repointed = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_bridge',
    name: 'SQL bridge repointed',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    principal: 'owner_1',
    config: { dataSourceId: 'ds-2' },
  })
  assert.equal(repointed.config.dataSourceId, 'ds-2', 'an owner may repoint the binding')
  assert.equal(repointed.config.dataSourceOwnerId, 'owner_1', 're-stamped by the validated principal')
  assert.equal(repointed.config.schema, 'dbo', 'and a repoint still preserves the rest of the config')

  // 5. Clearing stays possible and stays explicit: an explicit null releases the pin, and the
  //    orphaned stamp goes with it rather than leaving an un-attributable reference behind.
  const unbound = await registry.upsertExternalSystem({
    tenantId: 'tenant_1',
    id: 'sys_bridge',
    name: 'SQL bridge unbound',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    principal: 'owner_1',
    config: { dataSourceId: null },
  })
  assert.equal(unbound.config.dataSourceId, null, 'an explicit null clears the pointer')
  assert.equal(unbound.config.dataSourceOwnerId, undefined,
    'and the stamp does not outlive the pointer it attributed')
  assert.equal(unbound.config.schema, 'dbo', 'clearing one key clears only that key')

  console.log('  external-systems: bridge edit preserves the full config OK')
}
