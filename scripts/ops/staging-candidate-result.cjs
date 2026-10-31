const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MAX_BYTES = 16 * 1024 * 1024

function atomicFile(file, bytes, uid, gid) {
  if (fs.existsSync(file)) throw Error('RESULT_ALREADY_EXISTS')
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, bytes)
    if (uid !== process.getuid() || gid !== process.getgid()) fs.fchownSync(fd, uid, gid)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

function writeReceipt(value) {
  const file = process.env.QA_RESULT_PATH
  const nonce = process.env.QA_RESULT_NONCE
  const uid = Number(process.env.QA_RESULT_UID ?? process.getuid())
  const gid = Number(process.env.QA_RESULT_GID ?? process.getgid())
  if (!file || !path.isAbsolute(file) || !/^[0-9a-f]{32}$/.test(nonce || '')) throw Error('RESULT_TARGET_INVALID')
  if (![uid,gid].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('RESULT_OWNER_INVALID')
  if ((fs.statSync(path.dirname(file)).mode & 0o077) !== 0) throw Error('RESULT_DIRECTORY_NOT_PRIVATE')
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error('RESULT_SIZE_INVALID')
  atomicFile(file, bytes, uid, gid)
  const meta = { version: 1, state: 'complete', nonce, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  atomicFile(file + '.meta', Buffer.from(JSON.stringify(meta)), uid, gid)
  // Informational only: correctness depends on the atomic files, never stdout delivery.
  console.log('QA_FILE=complete')
}

function readReceipt(file, nonce) {
  const metaFile = file + '.meta'
  if ([file,metaFile].some(f => !fs.lstatSync(f).isFile())) throw Error('RESULT_FILE_INVALID')
  if (fs.statSync(metaFile).size > 1024) throw Error('RESULT_METADATA_INVALID')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  if (Object.keys(meta).sort().join(',') !== 'bytes,nonce,sha256,state,version' || meta.version !== 1 ||
      meta.state !== 'complete' || meta.nonce !== nonce || !Number.isSafeInteger(meta.bytes) ||
      meta.bytes < 1 || meta.bytes > MAX_BYTES || !/^[0-9a-f]{64}$/.test(meta.sha256 || '')) throw Error('RESULT_METADATA_INVALID')
  if (fs.statSync(file).size !== meta.bytes) throw Error('RESULT_SIZE_MISMATCH')
  const bytes = fs.readFileSync(file)
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw Error('RESULT_HASH_MISMATCH')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

module.exports = { writeReceipt, readReceipt }
