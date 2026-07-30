'use strict'

// Sealed-export S5 — pure signer helpers (issue #4690).
//
// LATENT. No public factory brands trust. Opaque private handles and first-party
// authorities are built only inside the product service composition root.
//
// Public surface:
//   - pure key material helpers (no trust)
//   - createCallerBuiltPublicVerifier (BUILD-ONLY, never trusted)
//   - pure verifyManifestWithPublicKeys (signature-only, for untrusted paths)
//
// Lifecycle-aware verification lives on the service-owned authority.

const crypto = require('node:crypto')

const contracts = require('./contracts.cjs')
const digests = require('./digests.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')

const SIGNATURE_ALGORITHM = 'ED25519'
const SIGNATURE_BYTES = 64

function isStrictObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isIdentityToken(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function normalizePublicKey(value) {
  let key
  try {
    key = value && value.type === 'public' ? value : crypto.createPublicKey(value)
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return key
}

function normalizePrivateKey(value) {
  let key
  try {
    key =
      value && value.type === 'private' ? value : crypto.createPrivateKey(value)
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (!key || key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return key
}

function deriveSignerKeyId(publicKey) {
  let der
  try {
    der = publicKey.export({ format: 'der', type: 'spki' })
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const digest = digests.digestBytes(der)
  if (!digest.ok) failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  return digest.digest
}

function createEd25519SignerMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return Object.freeze({
    privateKey,
    publicKey,
    signerKeyId: deriveSignerKeyId(publicKey),
  })
}

function decodeCanonicalSignature(value) {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
  }
  let bytes
  try {
    bytes = Buffer.from(value, 'base64')
  } catch {
    failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
  }
  if (bytes.length !== SIGNATURE_BYTES || bytes.toString('base64') !== value) {
    failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
  }
  return bytes
}

// BUILD-ONLY. Never brands trust. Signature-only check; no lifecycle.
function createCallerBuiltPublicVerifier({ signerKeys } = {}) {
  if (!Array.isArray(signerKeys) || signerKeys.length === 0) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const keys = new Map()
  for (let index = 0; index < signerKeys.length; index += 1) {
    const entry = signerKeys[index]
    if (
      !isStrictObject(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(entry, 'signerKeyId') ||
      !Object.prototype.hasOwnProperty.call(entry, 'publicKey') ||
      !isIdentityToken(entry.signerKeyId) ||
      keys.has(entry.signerKeyId)
    ) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    keys.set(entry.signerKeyId, normalizePublicKey(entry.publicKey))
  }
  return Object.freeze({
    trusted: false,
    verify(manifest) {
      if (!manifest || manifest.signatureAlgorithm !== SIGNATURE_ALGORITHM) {
        failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
      }
      const publicKey = keys.get(manifest.signerKeyId)
      if (!publicKey) failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
      const signature = decodeCanonicalSignature(manifest.signature)
      let valid = false
      try {
        valid = crypto.verify(
          null,
          contracts.computeSignedManifestBytes(manifest),
          publicKey,
          signature,
        )
      } catch {
        valid = false
      }
      if (!valid) failSealedExport('SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID')
      return Object.freeze({
        signatureAlgorithm: SIGNATURE_ALGORITHM,
        signatureVerified: true,
        lifecycleChecked: false,
      })
    },
  })
}

module.exports = Object.freeze({
  SIGNATURE_ALGORITHM,
  createCallerBuiltPublicVerifier,
  createEd25519SignerMaterial,
  deriveSignerKeyId,
  normalizePublicKey,
  normalizePrivateKey,
  decodeCanonicalSignature,
})
