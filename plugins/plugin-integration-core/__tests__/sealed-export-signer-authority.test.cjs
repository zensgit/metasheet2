'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  createCallerBuiltPublicVerifier,
  createEd25519SignerMaterial,
  SIGNATURE_ALGORITHM,
} = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
const {
  createHermeticSqlServerSealedSnapshotServiceForTests:
    createSqlServerSealedSnapshotService,
} = require('./support/sealed-export-s5-hermetic-service.cjs')
const {
  computeQueryBindingDigest,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
} = require('../lib/sealed-export/sqlserver-sealed-snapshot-action.cjs')
const {
  createSignerAuthorityStore,
  AUTHORITY_STATE_TABLE,
  PUBLIC_KEY_TABLE,
} = require('../lib/sealed-export/sealed-export-signer-authority-store.cjs')
const {
  createMemorySignerAuthorityDb,
} = require('./support/sealed-export-signer-authority-memory-db.cjs')

function expectReason(fn, reason) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  return caught
}

function sourceRows() {
  return [
    {
      __databaseId: 7,
      __isolationLevel: 5,
      __productMajor: 16,
      __sessionId: 41,
      __snapshotEnabledState: 1,
      __transactionId: '9001',
      payload: 'p',
      payloadVersion: 1,
      rowId: 1,
    },
  ]
}

const QUALIFICATION_DIGEST = 'a'.repeat(64)

function authorityScope() {
  return {
    tenantId: 'tenant-s5',
    workspaceId: null,
    systemContentKey: 's5-system-content',
    tenantDomainBinding: 'dom',
    roleBindingFingerprint: 'rb',
  }
}

function authorityRow(material, qualificationDigest, overrides = {}) {
  return {
    tenant_id: 'tenant-s5',
    workspace_id: null,
    tenant_domain_binding: 'dom',
    system_content_key: 's5-system-content',
    role_binding_fingerprint: 'rb',
    signer_key_id: material.signerKeyId,
    signer_status: 'ACTIVE',
    signer_expires_at: '2099-01-01T00:00:00.000Z',
    binding_current: true,
    binding_expires_at: '2099-01-01T00:00:00.000Z',
    qualification_digest: qualificationDigest,
    qualification_current: true,
    qualification_expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

async function buildService(material, artifactRoot) {
  const db = createMemorySignerAuthorityDb()
  const store = createSignerAuthorityStore({ db })
  await store.enrollPublicKey(authorityScope(), {
    publicKey: material.publicKey,
    signerKeyId: material.signerKeyId,
  })
  const service = createSqlServerSealedSnapshotService({
    tenantId: 'tenant-s5',
    workspaceId: null,
    systemContentKey: 's5-system-content',
    artifactRoot,
    hermeticCapture: { rows: sourceRows(), snapshotCapable: true },
    qualificationKeyring: {
      keyId: 'k',
      secret: crypto.randomBytes(32),
    },
    approvedBindings: [
      {
        objectKey: 'orders.lines',
        relationId: 'sqlserver.relation.rowid_payload.v1',
        tableRef: 'dbo.orders_lines',
        approvedConfigVersionId: 'c',
        bindingVersion: 'b',
        configContentKey: 'cfg',
        canonicalObjectVersion: 'v1',
        roleBindingFingerprint: 'rb',
        tenantDomainBinding: 'dom',
      },
    ],
    authorityDb: db,
    privateSignerMaterials: [
      {
        privateKey: material.privateKey,
        signerKeyId: material.signerKeyId,
      },
    ],
  })
  async function qualify(overrides = {}) {
    const qualification = await service.probeQualificationForBinding(
      'orders.lines',
    )
    await db.insertOne(
      AUTHORITY_STATE_TABLE,
      authorityRow(material, qualification.qualificationDigest, {
        qualification_expires_at: qualification.expiresAt,
        ...overrides,
      }),
    )
    return qualification
  }
  async function updateAuthority(patch) {
    await db.updateRow(
      AUTHORITY_STATE_TABLE,
      {
        tenant_id: 'tenant-s5',
        workspace_id: null,
        tenant_domain_binding: 'dom',
        system_content_key: 's5-system-content',
        role_binding_fingerprint: 'rb',
      },
      patch,
    )
  }
  return { db, qualify, service, store, updateAuthority }
}

async function positiveActiveSignViaService() {
  const material = createEd25519SignerMaterial()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 's5-signer-state-'))
  try {
    const { qualify, service, store } = await buildService(material, root)
    const qualification = await qualify()
    const resolved = await store.resolveAuthority(
      authorityScope(),
      qualification.qualificationDigest,
    )
    assert.equal(resolved.signerStatus, 'ACTIVE')
    assert.equal(resolved.signerKeyId, material.signerKeyId)
    assert.equal(JSON.stringify(resolved).includes('private'), false)
    assert.equal(service.listPublicSignerStates, undefined)
  } finally {
    await fs.rm(root, { force: true, recursive: true })
  }
}

async function lifecycleIndependentControls() {
  const material = createEd25519SignerMaterial()
  const queryDigest = computeQueryBindingDigest({
    objectKey: 'orders.lines',
    relationId: 'sqlserver.relation.rowid_payload.v1',
    tableRef: 'dbo.orders_lines',
  })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 's5-signer-'))
  try {
    const { qualify, service, updateAuthority } = await buildService(
      material,
      root,
    )
    const qualification = await qualify()
    const envelope = {
      exportRequestId: 'e',
      nonce: 'n',
      expiry: '2099-01-01T00:00:00.000Z',
      scenarioVersion: 's',
      bindingVersion: 'b',
      roleId: 'r',
      actionProfileVersion: 'sqlserver.sealed_snapshot.v1',
      roleBindingFingerprint: 'rb',
      systemContentKey: 's5-system-content',
      approvedConfigVersionId: 'c',
      configContentKey: 'cfg',
      canonicalObjectVersion: 'v1',
      qualificationDigest: qualification.qualificationDigest,
      executionMode: 'S5',
      applyProfileVersion: 'NO_APPLY',
      queryObjectFilterBindingDigest: queryDigest,
      expectedSourceSchemaFieldMapDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
      tenantDomainBinding: 'dom',
      rowBudget: 100,
      byteBudget: 1024 * 1024,
      chunkBudget: 20,
    }
    const result = await service.execute({ envelope })

    await updateAuthority({ signer_status: 'EXPIRED' })
    await expectReasonAsync(
      () =>
        service.verifyManifestWithLifecycle({
          envelope,
          manifest: result.manifest,
        }),
      'SEALED_EXPORT_SIGNER_EXPIRED',
    )

    await updateAuthority({ signer_status: 'REVOKED' })
    await expectReasonAsync(
      () =>
        service.verifyManifestWithLifecycle({
          envelope,
          manifest: result.manifest,
        }),
      'SEALED_EXPORT_SIGNER_REVOKED',
    )

    const callerBuilt = createCallerBuiltPublicVerifier({
      signerKeys: [
        {
          signerKeyId: material.signerKeyId,
          publicKey: material.publicKey,
        },
      ],
    })
    assert.equal(callerBuilt.trusted, false)
    const verified = callerBuilt.verify(result.manifest)
    assert.equal(verified.lifecycleChecked, false)
    assert.equal(verified.signatureAlgorithm, SIGNATURE_ALGORITHM)
  } finally {
    await fs.rm(root, { force: true, recursive: true })
  }
}

async function splitBrainPublicKeyWithout069LifecycleFails() {
  // Old dual-write design: public key "ACTIVE" in 070 while 069 is REVOKED.
  // New design: only 069 lifecycle is consulted; public key has no status.
  const material = createEd25519SignerMaterial()
  const db = createMemorySignerAuthorityDb()
  const store = createSignerAuthorityStore({ db })
  const scope = authorityScope()
  await store.enrollPublicKey(scope, {
    signerKeyId: material.signerKeyId,
    publicKey: material.publicKey,
  })
  await db.insertOne(
    AUTHORITY_STATE_TABLE,
    authorityRow(material, QUALIFICATION_DIGEST, {
      signer_status: 'REVOKED',
    }),
  )
  // Public key is present (070); lifecycle is REVOKED (069) → verify path fails.
  await expectReasonAsync(
    () => store.resolveAuthority(scope, QUALIFICATION_DIGEST),
    'SEALED_EXPORT_SIGNER_REVOKED',
  )

  // Positive control: same public material + ACTIVE 069 lifecycle succeeds.
  await db.updateRow(AUTHORITY_STATE_TABLE, {
    tenant_id: 'tenant-s5',
    workspace_id: null,
    tenant_domain_binding: 'dom',
    system_content_key: 's5-system-content',
    role_binding_fingerprint: 'rb',
  }, {
    signer_status: 'ACTIVE',
  })
  const resolved = await store.resolveAuthority(scope, QUALIFICATION_DIGEST)
  assert.equal(resolved.signerStatus, 'ACTIVE')
  assert.equal(resolved.signerKeyId, material.signerKeyId)

  // Refuse embedding status on public-key enrollment (dual-write surface).
  await expectReasonAsync(
    () =>
      store.enrollPublicKey(scope, {
        signerKeyId: material.signerKeyId,
        publicKey: material.publicKey,
        status: 'ACTIVE',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    'SEALED_EXPORT_SIGNER_UNENROLLED',
  )

  // Service construction refuses lifecycle fields on private key material.
  const serviceConfig = {
    tenantId: 'tenant-s5',
    workspaceId: null,
    systemContentKey: 's5-system-content',
    artifactRoot: os.tmpdir(),
    hermeticCapture: { rows: sourceRows(), snapshotCapable: true },
    qualificationKeyring: {
      keyId: 'k',
      secret: crypto.randomBytes(32),
    },
    approvedBindings: [
      {
        objectKey: 'orders.lines',
        relationId: 'sqlserver.relation.rowid_payload.v1',
        tableRef: 'dbo.orders_lines',
        approvedConfigVersionId: 'c',
        bindingVersion: 'b',
        configContentKey: 'cfg',
        canonicalObjectVersion: 'v1',
        roleBindingFingerprint: 'rb',
        tenantDomainBinding: 'dom',
      },
    ],
    authorityDb: db,
  }
  for (const privateMaterial of [
    {
      privateKey: material.privateKey,
      signerKeyId: material.signerKeyId,
      status: 'ACTIVE',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    {
      privateKey: material.privateKey,
      signerKeyId: 7,
    },
    {
      privateKey: material.privateKey,
      signerKeyId: material.signerKeyId,
      unapprovedField: 'not-admitted',
    },
  ]) {
    expectReason(
      () =>
        createSqlServerSealedSnapshotService({
          ...serviceConfig,
          privateSignerMaterials: [privateMaterial],
        }),
      'SEALED_EXPORT_SIGNER_UNENROLLED',
    )
  }
}

async function expectReasonAsync(fn, reason) {
  let caught
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  return caught
}

async function main() {
  await positiveActiveSignViaService()
  await lifecycleIndependentControls()
  await splitBrainPublicKeyWithout069LifecycleFails()
  console.log('sealed-export-signer-authority.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
