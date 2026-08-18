'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const { failSealedExport } = require('./failure-vocabulary.cjs')

const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/

// NTFS exposes no directory-fsync primitive. `fs.open(dir, 'r')` succeeds on win32
// but the subsequent `handle.sync()` raises EPERM for EVERY directory, so the
// durability barrier in syncDirectory() below is unreachable there — not
// occasionally, always. Before this constant existed, the first writeChunk() of the
// first run on a Windows host hardlinked the chunk into place and THEN refused with
// SEALED_EXPORT_STAGING_WRITE_FAILED, so the chunk was on disk while the caller was
// told the write had failed, and every retry re-entered the same refusal.
//
// The skip is narrow and it is only a DURABILITY barrier that is skipped:
//   - the per-file fsync in writeChunk() still runs on every platform;
//   - the chunk digest, the manifest digest and the EXISTING_IDENTICAL byte compare
//     are untouched, so no integrity control is weakened;
//   - on POSIX this module is byte-identical to its previous behaviour, including
//     the fail-closed refusal for any other syncDirectory() error.
// What a win32 host loses is the crash-consistency guarantee that the directory
// entry survives a power loss; a lost entry re-presents as a missing chunk, which
// the chunk-set completeness check already refuses.
const DIRECTORY_FSYNC_SUPPORTED = process.platform !== 'win32'

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
}

function assertChunkIndex(chunkIndex) {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    failSealedExport('SEALED_EXPORT_CHUNK_UNDECLARED')
  }
}

function ownBytes(input) {
  if (!(input instanceof Uint8Array)) {
    failSealedExport('SEALED_EXPORT_CHUNK_DIGEST_MISMATCH')
  }
  return Buffer.from(input)
}

function sameBytes(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function createPrivateIngestionBlobStore({ rootDir } = {}) {
  if (
    typeof rootDir !== 'string'
    || !path.isAbsolute(rootDir)
    || rootDir.indexOf('\0') >= 0
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const privateRoot = path.resolve(rootDir)
  if (privateRoot === path.parse(privateRoot).root) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  function sessionDir(sessionId) {
    assertSessionId(sessionId)
    return path.join(privateRoot, sessionId)
  }

  function chunkPath(sessionId, chunkIndex) {
    assertChunkIndex(chunkIndex)
    return path.join(sessionDir(sessionId), `chunk-${chunkIndex}.bin`)
  }

  async function createSessionArea(sessionId) {
    const directory = sessionDir(sessionId)
    try {
      await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 })
      await fs.chmod(privateRoot, 0o700)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.chmod(directory, 0o700)
    } catch {
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
    return directory
  }

  async function existingSessionDirectory(sessionId) {
    const directory = sessionDir(sessionId)
    let stat
    try {
      stat = await fs.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
      }
      await fs.chmod(directory, 0o700)
    } catch {
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
    return directory
  }

  async function syncDirectory(directory) {
    if (!DIRECTORY_FSYNC_SUPPORTED) return
    let handle = null
    try {
      handle = await fs.open(directory, 'r')
      await handle.sync()
      await handle.close()
      handle = null
    } catch {
      if (handle !== null) {
        try { await handle.close() } catch {}
      }
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
  }

  async function writeChunk(sessionId, chunkIndex, input) {
    const bytes = ownBytes(input)
    // Deliberately do not mkdir here. Cleanup first fences the DB session and then
    // removes this directory; an already-started writer must fail instead of
    // recreating a post-cleanup orphan.
    const directory = await existingSessionDirectory(sessionId)
    const finalPath = chunkPath(sessionId, chunkIndex)
    let suffix
    try {
      suffix = crypto.randomBytes(12).toString('hex')
    } catch {
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
    const tempPath = path.join(
      directory,
      `chunk-${chunkIndex}.tmp-${suffix}`,
    )
    let handle = null
    try {
      handle = await fs.open(tempPath, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = null
      await fs.chmod(tempPath, 0o600)
    } catch {
      if (handle !== null) {
        try { await handle.close() } catch {}
      }
      try { await fs.unlink(tempPath) } catch {}
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }

    let linked = false
    let linkConflict = false
    try {
      await fs.link(tempPath, finalPath)
      linked = true
    } catch (error) {
      linkConflict = Boolean(error && error.code === 'EEXIST')
    }
    try { await fs.unlink(tempPath) } catch {}

    if (linked) {
      await syncDirectory(directory)
      return Object.freeze({ outcome: 'CREATED', byteCount: bytes.length })
    }
    if (!linkConflict) failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')

    let existing
    try {
      existing = await fs.readFile(finalPath)
    } catch {
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
    if (!sameBytes(existing, bytes)) {
      failSealedExport('SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT', { chunkIndex })
    }
    await syncDirectory(directory)
    return Object.freeze({ outcome: 'EXISTING_IDENTICAL', byteCount: bytes.length })
  }

  async function readChunk(sessionId, chunkIndex) {
    let bytes
    try {
      bytes = await fs.readFile(chunkPath(sessionId, chunkIndex))
    } catch {
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
    return Buffer.from(bytes)
  }

  async function readChunkIfPresent(sessionId, chunkIndex) {
    let bytes
    try {
      bytes = await fs.readFile(chunkPath(sessionId, chunkIndex))
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
    return Buffer.from(bytes)
  }

  async function removeSession(sessionId) {
    try {
      await fs.rm(sessionDir(sessionId), { recursive: true, force: true })
    } catch {
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
    await syncDirectory(privateRoot)
    return Object.freeze({ outcome: 'REMOVED' })
  }

  return Object.freeze({
    createSessionArea,
    writeChunk,
    readChunk,
    readChunkIfPresent,
    removeSession,
  })
}

module.exports = Object.freeze({
  createPrivateIngestionBlobStore,
})
