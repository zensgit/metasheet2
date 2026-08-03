'use strict'

const crypto = require('node:crypto')

const contracts = require('./contracts.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  isSqlServerSealedSnapshotService,
} = require('./sqlserver-sealed-snapshot-service.cjs')

const SIGNATURE_ALGORITHM = 'ED25519'
const SIGNATURE_BYTES = 64
const trustedManifestVerifiers = new WeakSet()

function isIdentityToken(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function decodeCanonicalSignature(value) {
  if (
    typeof value !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
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

function buildPrivateIngestionManifestVerifier({ signerKeys } = {}) {
  if (!Array.isArray(signerKeys) || signerKeys.length === 0) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const keys = new Map()
  for (let index = 0; index < signerKeys.length; index += 1) {
    const entry = signerKeys[index]
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.prototype.hasOwnProperty.call(entry, 'signerKeyId')
      || !Object.prototype.hasOwnProperty.call(entry, 'publicKey')
      || !isIdentityToken(entry.signerKeyId)
      || keys.has(entry.signerKeyId)
    ) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    keys.set(entry.signerKeyId, normalizePublicKey(entry.publicKey))
  }
  const verifier = Object.freeze({
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
      })
    },
  })
  return verifier
}

// BUILD-ONLY. A caller-provided signer list never grants trust.
//
// This is the INERT PROJECTION of the verifier: byte-for-byte the same
// `verify()` behaviour as the certified path builds for its own use, with NO
// brand. A test that needs a verifier's BEHAVIOUR uses this and gets refused by
// `createPrivateIngestionService` — which is the correct answer, not a gap.
function createPrivateIngestionManifestVerifier(options) {
  return buildPrivateIngestionManifestVerifier(options)
}

// REMOVED (#4636 residual, re-triaged 2026-08-02): a
// `createHarnessPrivateIngestionManifestVerifierForTests` used to live here and
// was PUBLICLY EXPORTED while adding its product to `trustedManifestVerifiers`.
// It was deferred as contained by latency ("no runtime consumer in S3"); that
// containment DOES NOT HOLD for this stack any more — `index.cjs` wires
// `stock-preparation-sqlserver-runtime.cjs`, which requires this module at :15.
// It is deleted rather than renamed: a narrower same-shape replacement would be
// the same grant under a different name.
//
// `createSqlServerPrivateIngestionManifestVerifier` below is now the ONLY writer
// of `trustedManifestVerifiers`, and it admits nothing a caller can fabricate —
// its `sealedSnapshotService` must already carry the `productServices` brand, so
// the whole ingestion trust chain is rooted in
// `createSqlServerSealedSnapshotService`.
function createSqlServerPrivateIngestionManifestVerifier({
  envelope: rawEnvelope,
  sealedSnapshotService,
} = {}) {
  if (!isSqlServerSealedSnapshotService(sealedSnapshotService)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const envelope = contracts.validateExportRequestEnvelope(rawEnvelope)
  const verifier = Object.freeze({
    async verify(manifest) {
      return sealedSnapshotService.verifyManifestWithLifecycle({
        envelope,
        manifest,
      })
    },
  })
  trustedManifestVerifiers.add(verifier)
  return verifier
}

function isTrustedPrivateIngestionManifestVerifier(value) {
  return trustedManifestVerifiers.has(value)
}

module.exports = Object.freeze({
  SIGNATURE_ALGORITHM,
  createPrivateIngestionManifestVerifier,
  createSqlServerPrivateIngestionManifestVerifier,
  isTrustedPrivateIngestionManifestVerifier,
})
