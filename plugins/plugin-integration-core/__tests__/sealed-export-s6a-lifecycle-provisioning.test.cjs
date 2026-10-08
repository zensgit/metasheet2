'use strict'

const assert = require('node:assert/strict')

const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  createSealedExportLifecycleProvisioning,
} = require(
  '../lib/sealed-export/sealed-export-lifecycle-provisioning.cjs'
)
const {
  createEd25519SignerMaterial,
} = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
const {
  AUTHORITY_STATE_TABLE,
  PUBLIC_KEY_TABLE,
} = require(
  '../lib/sealed-export/sealed-export-signer-authority-store.cjs'
)

const NOW_MS = Date.parse('2026-07-31T00:00:00Z')
const SCOPE = Object.freeze({
  roleBindingFingerprint: 'role-binding-s6a',
  systemContentKey: 'system-content-s6a',
  tenantDomainBinding: 'tenant-domain-s6a',
  tenantId: 'tenant-s6a',
  workspaceId: null,
})

function rowKey(row) {
  return [
    row.tenant_id,
    row.workspace_id || '',
    row.tenant_domain_binding,
    row.system_content_key,
    row.role_binding_fingerprint,
  ].join('\u0000')
}

function publicKeyRowKey(row) {
  return `${rowKey(row)}\u0000${row.signer_key_id}`
}

function matches(row, where) {
  return Object.keys(where).every((field) => {
    const expected = where[field]
    const actual = row[field]
    return expected === null
      ? actual === null || actual === undefined
      : actual === expected
  })
}

function cloneState(state) {
  return {
    authority: new Map(
      [...state.authority].map(([key, row]) => [key, { ...row }]),
    ),
    publicKeys: new Map(
      [...state.publicKeys].map(([key, row]) => [
        key,
        { ...row, public_key_spki_der: Buffer.from(row.public_key_spki_der) },
      ]),
    ),
    terminal: new Map(state.terminal),
  }
}

function createMemoryDb() {
  let state = {
    authority: new Map(),
    publicKeys: new Map(),
    terminal: new Map(),
  }
  let failAuthorityInsert = false

  function scopedApi(target) {
    return {
      async insertOne(table, row) {
        if (table === PUBLIC_KEY_TABLE) {
          const key = publicKeyRowKey(row)
          if (target.publicKeys.has(key)) throw new Error('duplicate public key')
          target.publicKeys.set(key, {
            ...row,
            public_key_spki_der: Buffer.from(row.public_key_spki_der),
          })
          return [row]
        }
        if (table === AUTHORITY_STATE_TABLE) {
          if (failAuthorityInsert) {
            failAuthorityInsert = false
            throw new Error('driver leaked schema name: authority_state')
          }
          const key = rowKey(row)
          if (target.authority.has(key)) throw new Error('duplicate authority')
          target.authority.set(key, { ...row })
          return [row]
        }
        throw new Error('unexpected table')
      },
      async selectOneForUpdate(table, where) {
        if (table !== AUTHORITY_STATE_TABLE) throw new Error('unexpected table')
        for (const row of target.authority.values()) {
          if (matches(row, where)) return { ...row }
        }
        return null
      },
      async updateRow(table, patch, where) {
        if (table !== AUTHORITY_STATE_TABLE) throw new Error('unexpected table')
        for (const [key, current] of target.authority) {
          if (!matches(current, where)) continue
          const next = { ...current, ...patch }
          if (
            current.signer_status === 'REVOKED'
            || current.signer_status === 'EXPIRED'
          ) {
            target.terminal.set(
              `${key}\u0000${current.signer_key_id}`,
              current.signer_status,
            )
          }
          if (
            next.signer_status === 'ACTIVE'
            && target.terminal.has(`${key}\u0000${next.signer_key_id}`)
          ) {
            throw new Error('terminal signer key cannot be re-activated')
          }
          if (
            next.signer_status === 'REVOKED'
            || next.signer_status === 'EXPIRED'
          ) {
            target.terminal.set(
              `${key}\u0000${next.signer_key_id}`,
              next.signer_status,
            )
          }
          target.authority.set(key, next)
          return [{ ...next }]
        }
        return []
      },
    }
  }

  return Object.freeze({
    async insertOne(...args) {
      return scopedApi(state).insertOne(...args)
    },
    async selectOneForUpdate(...args) {
      return scopedApi(state).selectOneForUpdate(...args)
    },
    async updateRow(...args) {
      return scopedApi(state).updateRow(...args)
    },
    async transaction(callback) {
      const candidate = cloneState(state)
      const result = await callback(scopedApi(candidate))
      state = candidate
      return result
    },
    failNextAuthorityInsert() {
      failAuthorityInsert = true
    },
    snapshot() {
      return cloneState(state)
    },
  })
}

function authorityInput(publicKey, overrides = {}) {
  return {
    bindingExpiresAt: '2026-08-01T00:00:00Z',
    publicKey,
    qualificationDigest: 'b'.repeat(64),
    qualificationExpiresAt: '2026-08-01T00:00:00Z',
    scope: SCOPE,
    signerExpiresAt: '2026-08-02T00:00:00Z',
    ...overrides,
  }
}

async function refuses(action, reason) {
  let caught = null
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  assert.equal(caught.message.includes('authority_state'), false)
  return caught
}

async function main() {
  {
    const db = createMemoryDb()
    const material = createEd25519SignerMaterial()
    const service = createSealedExportLifecycleProvisioning({
      db,
      clock: () => NOW_MS,
    })
    const enrolled = await service.enrollSigner(
      authorityInput(material.publicKey),
    )
    assert.deepEqual(enrolled, {
      changed: true,
      externalWrite: false,
      operation: 'ENROLLED',
      valuesFree: true,
    })
    const snapshot = db.snapshot()
    assert.equal(snapshot.authority.size, 1)
    assert.equal(snapshot.publicKeys.size, 1)
    assert.equal(snapshot.terminal.size, 0)
    assert.equal(
      [...snapshot.authority.values()][0].signer_key_id,
      material.signerKeyId,
    )
  }

  {
    const db = createMemoryDb()
    const material = createEd25519SignerMaterial()
    const service = createSealedExportLifecycleProvisioning({
      db,
      clock: () => NOW_MS,
    })
    db.failNextAuthorityInsert()
    await refuses(
      () => service.enrollSigner(authorityInput(material.publicKey)),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
    const snapshot = db.snapshot()
    assert.equal(snapshot.authority.size, 0)
    assert.equal(snapshot.publicKeys.size, 0)
  }

  {
    const db = createMemoryDb()
    const oldMaterial = createEd25519SignerMaterial()
    const newMaterial = createEd25519SignerMaterial()
    const service = createSealedExportLifecycleProvisioning({
      db,
      clock: () => NOW_MS,
    })
    await service.enrollSigner(authorityInput(oldMaterial.publicKey))
    const rotated = await service.rotateSigner(authorityInput(
      newMaterial.publicKey,
      { qualificationDigest: 'c'.repeat(64) },
    ))
    assert.equal(rotated.operation, 'ROTATED')
    const snapshot = db.snapshot()
    const active = [...snapshot.authority.values()][0]
    assert.equal(active.signer_key_id, newMaterial.signerKeyId)
    assert.equal(active.signer_status, 'ACTIVE')
    assert.equal(
      snapshot.terminal.get(
        `${rowKey(active)}\u0000${oldMaterial.signerKeyId}`,
      ),
      'REVOKED',
    )
    await refuses(
      () => service.rotateSigner(authorityInput(oldMaterial.publicKey)),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
    assert.equal(
      [...db.snapshot().authority.values()][0].signer_key_id,
      newMaterial.signerKeyId,
    )
  }

  {
    const db = createMemoryDb()
    const material = createEd25519SignerMaterial()
    const service = createSealedExportLifecycleProvisioning({
      db,
      clock: () => NOW_MS,
    })
    await service.enrollSigner(authorityInput(material.publicKey))
    const first = await service.setSignerTerminal({
      scope: SCOPE,
      status: 'REVOKED',
    })
    const replay = await service.setSignerTerminal({
      scope: SCOPE,
      status: 'REVOKED',
    })
    assert.equal(first.changed, true)
    assert.equal(replay.changed, false)
    await refuses(
      () => service.refreshBindingQualification({
        bindingExpiresAt: '2026-08-01T00:00:00Z',
        qualificationDigest: 'd'.repeat(64),
        qualificationExpiresAt: '2026-08-01T00:00:00Z',
        scope: SCOPE,
      }),
      'SEALED_EXPORT_SIGNER_REVOKED',
    )
  }

  {
    const db = createMemoryDb()
    const material = createEd25519SignerMaterial()
    const service = createSealedExportLifecycleProvisioning({
      db,
      clock: () => NOW_MS,
    })
    await service.enrollSigner(authorityInput(material.publicKey))
    const refreshed = await service.refreshBindingQualification({
      bindingExpiresAt: '2026-08-01T12:00:00Z',
      qualificationDigest: 'e'.repeat(64),
      qualificationExpiresAt: '2026-08-01T12:00:00Z',
      scope: SCOPE,
    })
    assert.equal(refreshed.operation, 'QUALIFICATION_REFRESHED')
    assert.equal(
      [...db.snapshot().authority.values()][0].qualification_digest,
      'e'.repeat(64),
    )
  }

  {
    const db = createMemoryDb()
    const material = createEd25519SignerMaterial()
    const service = createSealedExportLifecycleProvisioning({
      db,
      clock: () => NOW_MS,
    })
    await refuses(
      () => service.enrollSigner(authorityInput(material.publicKey, {
        bindingExpiresAt: '2026-08-03T00:00:00Z',
      })),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
    await refuses(
      () => service.enrollSigner({
        ...authorityInput(material.publicKey),
        callerField: 'forbidden',
      }),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
    await refuses(
      () => service.enrollSigner({
        ...authorityInput(material.publicKey),
        get publicKey() {
          throw new Error('foreign getter')
        },
      }),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
  }

  console.log('sealed-export-s6a-lifecycle-provisioning.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
