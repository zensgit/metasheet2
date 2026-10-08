'use strict'

const assert = require('node:assert/strict')

const digests = require('../lib/sealed-export/digests.cjs')
const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  createEd25519SignerMaterial,
} = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
const {
  createSignerAuthorityStore,
  TABLE,
  PUBLIC_KEY_TABLE,
  AUTHORITY_STATE_TABLE,
  workspaceScopeKey,
} = require('../lib/sealed-export/sealed-export-signer-authority-store.cjs')
const {
  createMemorySignerAuthorityDb,
} = require('./support/sealed-export-signer-authority-memory-db.cjs')

async function expectReasonAsync(fn, reason) {
  let caught
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError, `expected ${reason}`)
  assert.equal(caught.reason, reason)
  return caught
}

function scope() {
  return {
    tenantId: 'tenant-s5',
    workspaceId: null,
    systemContentKey: 's5-system-content',
    tenantDomainBinding: 's5-tenant-domain',
    roleBindingFingerprint: 's5-role-binding',
  }
}

const QUALIFICATION_DIGEST = 'a'.repeat(64)
const NOW_MS = Date.parse('2026-07-30T00:00:00.000Z')

function authorityRow(material, overrides = {}) {
  return {
    tenant_id: 'tenant-s5',
    workspace_id: null,
    tenant_domain_binding: 's5-tenant-domain',
    system_content_key: 's5-system-content',
    role_binding_fingerprint: 's5-role-binding',
    signer_key_id: material.signerKeyId,
    signer_status: 'ACTIVE',
    signer_expires_at: '2099-01-01T00:00:00.000Z',
    binding_current: true,
    binding_expires_at: '2099-01-01T00:00:00.000Z',
    qualification_digest: QUALIFICATION_DIGEST,
    qualification_current: true,
    qualification_expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

async function positiveEnrollPublicKeyAndLifecycle() {
  const db = createMemorySignerAuthorityDb()
  const store = createSignerAuthorityStore({ db, clock: () => NOW_MS })
  assert.equal(TABLE, PUBLIC_KEY_TABLE)
  assert.equal(AUTHORITY_STATE_TABLE, 'integration_sealed_export_authority_state')
  assert.equal(workspaceScopeKey(null), '')

  const material = createEd25519SignerMaterial()
  const enrolled = await store.enrollPublicKey(scope(), {
    signerKeyId: material.signerKeyId,
    publicKey: material.publicKey,
  })
  assert.equal(enrolled.signerKeyId, material.signerKeyId)
  assert.equal(Object.prototype.hasOwnProperty.call(enrolled, 'status'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(enrolled, 'expiresAt'), false)

  await db.insertOne(AUTHORITY_STATE_TABLE, authorityRow(material))
  const lifecycle = await store.getAuthorityState(scope())
  assert.equal(lifecycle.signerStatus, 'ACTIVE')
  assert.equal(lifecycle.signerKeyId, material.signerKeyId)
  assert.equal(lifecycle.bindingCurrent, true)
  assert.equal(lifecycle.qualificationDigest, QUALIFICATION_DIGEST)
  assert.equal(store.putSignerLifecycle, undefined)

  const resolved = await store.resolveAuthority(scope(), QUALIFICATION_DIGEST)
  assert.equal(resolved.signerStatus, 'ACTIVE')
  const { resolveAuthority } = store
  const detachedResolved = await resolveAuthority(scope(), QUALIFICATION_DIGEST)
  assert.equal(detachedResolved.signerKeyId, material.signerKeyId)
}

async function publicKeyEnrollmentRefusesLifecycleFields() {
  const store = createSignerAuthorityStore({
    db: createMemorySignerAuthorityDb(),
  })
  const material = createEd25519SignerMaterial()
  await expectReasonAsync(
    () =>
      store.enrollPublicKey(scope(), {
        signerKeyId: material.signerKeyId,
        publicKey: material.publicKey,
        status: 'ACTIVE',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    'SEALED_EXPORT_SIGNER_UNENROLLED',
  )
  await expectReasonAsync(
    () =>
      store.enrollPublicKey(scope(), {
        signerKeyId: material.signerKeyId,
        publicKey: material.publicKey,
        privateKey: material.privateKey,
      }),
    'SEALED_EXPORT_SIGNER_UNENROLLED',
  )
}

async function splitBrainRevokedLifecycleWithPresentPublicKeyFails() {
  const db = createMemorySignerAuthorityDb()
  const store = createSignerAuthorityStore({ db, clock: () => NOW_MS })
  const material = createEd25519SignerMaterial()
  await store.enrollPublicKey(scope(), {
    signerKeyId: material.signerKeyId,
    publicKey: material.publicKey,
  })
  await db.insertOne(
    AUTHORITY_STATE_TABLE,
    authorityRow(material, { signer_status: 'REVOKED' }),
  )
  await expectReasonAsync(
    () => store.resolveAuthority(scope(), QUALIFICATION_DIGEST),
    'SEALED_EXPORT_SIGNER_REVOKED',
  )
  const rotated = createEd25519SignerMaterial()
  await store.enrollPublicKey(scope(), {
    signerKeyId: rotated.signerKeyId,
    publicKey: rotated.publicKey,
  })
  await db.updateRow(AUTHORITY_STATE_TABLE, {
    tenant_id: 'tenant-s5',
    workspace_id: null,
    tenant_domain_binding: 's5-tenant-domain',
    system_content_key: 's5-system-content',
    role_binding_fingerprint: 's5-role-binding',
  }, {
    signer_key_id: rotated.signerKeyId,
    signer_status: 'ACTIVE',
  })
  const ok = await store.resolveAuthority(scope(), QUALIFICATION_DIGEST)
  assert.equal(ok.signerKeyId, rotated.signerKeyId)
}

async function bindingAndQualificationStateAreLiveAndClosed() {
  for (const [patch, reason] of [
    [{ binding_current: false }, 'SEALED_EXPORT_BINDING_UNQUALIFIED'],
    [
      { binding_expires_at: '2026-07-29T00:00:00.000Z' },
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    ],
    [{ qualification_current: false }, 'SEALED_EXPORT_BINDING_UNQUALIFIED'],
    [
      { qualification_expires_at: '2026-07-29T00:00:00.000Z' },
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    ],
  ]) {
    const db = createMemorySignerAuthorityDb()
    const store = createSignerAuthorityStore({ db, clock: () => NOW_MS })
    const material = createEd25519SignerMaterial()
    await store.enrollPublicKey(scope(), {
      signerKeyId: material.signerKeyId,
      publicKey: material.publicKey,
    })
    await db.insertOne(AUTHORITY_STATE_TABLE, authorityRow(material, patch))
    await expectReasonAsync(
      () => store.resolveAuthority(scope(), QUALIFICATION_DIGEST),
      reason,
    )
  }

  const db = createMemorySignerAuthorityDb()
  const material = createEd25519SignerMaterial()
  const store = createSignerAuthorityStore({ db, clock: () => NOW_MS })
  await store.enrollPublicKey(scope(), {
    signerKeyId: material.signerKeyId,
    publicKey: material.publicKey,
  })
  await db.insertOne(AUTHORITY_STATE_TABLE, authorityRow(material))
  await expectReasonAsync(
    () => store.resolveAuthority(scope(), 'b'.repeat(64)),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )

  const invalidDateDb = createMemorySignerAuthorityDb()
  const invalidDateStore = createSignerAuthorityStore({
    db: invalidDateDb,
    clock: () => NOW_MS,
  })
  await invalidDateDb.insertOne(
    AUTHORITY_STATE_TABLE,
    authorityRow(material, { signer_expires_at: new Date(Number.NaN) }),
  )
  await expectReasonAsync(
    () => invalidDateStore.getAuthorityState(scope()),
    'SEALED_EXPORT_SIGNER_UNENROLLED',
  )
}

async function nullWorkspaceMatchesViaIsNullSemantics() {
  const db = createMemorySignerAuthorityDb()
  const store = createSignerAuthorityStore({ db })
  const material = createEd25519SignerMaterial()
  await store.enrollPublicKey(scope(), {
    signerKeyId: material.signerKeyId,
    publicKey: material.publicKey,
  })
  const rows = await db.select(PUBLIC_KEY_TABLE, {
    where: {
      tenant_id: 'tenant-s5',
      workspace_id: null,
      system_content_key: 's5-system-content',
      tenant_domain_binding: 's5-tenant-domain',
      role_binding_fingerprint: 's5-role-binding',
    },
  })
  assert.equal(rows.length, 1)
}

async function keyIdMustMatchPublicDigest() {
  const store = createSignerAuthorityStore({
    db: createMemorySignerAuthorityDb(),
  })
  const material = createEd25519SignerMaterial()
  const other = createEd25519SignerMaterial()
  await expectReasonAsync(
    () =>
      store.enrollPublicKey(scope(), {
        signerKeyId: other.signerKeyId,
        publicKey: material.publicKey,
      }),
    'SEALED_EXPORT_SIGNER_UNENROLLED',
  )
}

async function publicRecordHasNoPrivateOrLifecycleFields() {
  const store = createSignerAuthorityStore({
    db: createMemorySignerAuthorityDb(),
  })
  const material = createEd25519SignerMaterial()
  const enrolled = await store.enrollPublicKey(scope(), {
    signerKeyId: material.signerKeyId,
    publicKey: material.publicKey,
  })
  const text = JSON.stringify(enrolled, (_key, value) => {
    if (value && typeof value === 'object' && value.type === 'public') {
      return { type: 'public', asymmetricKeyType: value.asymmetricKeyType }
    }
    return value
  })
  assert.equal(text.includes('private'), false)
  assert.equal(text.includes('ACTIVE'), false)
  assert.ok(digests.isLowerHexDigest(enrolled.signerKeyId))
}

async function main() {
  await positiveEnrollPublicKeyAndLifecycle()
  await publicKeyEnrollmentRefusesLifecycleFields()
  await splitBrainRevokedLifecycleWithPresentPublicKeyFails()
  await bindingAndQualificationStateAreLiveAndClosed()
  await nullWorkspaceMatchesViaIsNullSemantics()
  await keyIdMustMatchPublicDigest()
  await publicRecordHasNoPrivateOrLifecycleFields()
  console.log('sealed-export-signer-authority-store.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
