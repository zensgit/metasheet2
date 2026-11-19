'use strict'

// Audit-child preload only. The installed package ships separate require and
// import builds. This file wraps the required compare. The sibling load hook
// rewrites the import build before evaluation. Both wrappers forward this,
// the arguments, and the original return value.

const MODE = process.env.SA_WORKER_MODE
if (MODE !== 'audit' && MODE !== 'audit-fault') return

const INSTALLED = Symbol.for('metasheet.security-action-audit-bcrypt-installed')
if (globalThis[INSTALLED] === true) return

const { register } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

if (typeof register !== 'function') throw new Error('compare observer missing')

const COUNT = Symbol.for('metasheet.security-action-audit-bcrypt-count')
const OBSERVE = Symbol.for('metasheet.security-action-audit-bcrypt-observe')
const NEEDLE = 'export function compare('

let count = 0

function observe() {
  count += 1
}

function readCount() {
  return count
}

Object.defineProperty(globalThis, INSTALLED, {
  enumerable: false,
  writable: false,
  configurable: false,
  value: true,
})
Object.defineProperty(globalThis, OBSERVE, {
  enumerable: false,
  writable: false,
  configurable: false,
  value: observe,
})
Object.defineProperty(globalThis, COUNT, {
  enumerable: false,
  writable: false,
  configurable: false,
  value: readCount,
})
Object.defineProperty(module.exports, COUNT, {
  enumerable: false,
  writable: false,
  configurable: false,
  value: readCount,
})

let cjsPath = ''
try {
  cjsPath = require.resolve('bcryptjs')
} catch (_error) {
  throw new Error('bcrypt compare export was not observed')
}

const esmPath = path.resolve(path.dirname(cjsPath), '..', 'index.js')
const esmUrl = pathToFileURL(esmPath).href
let installed = ''
try {
  installed = fs.readFileSync(esmPath, 'utf8')
} catch (_error) {
  throw new Error('bcrypt compare export was not observed')
}
if (installed.indexOf(NEEDLE) < 0 || installed.indexOf(NEEDLE) !== installed.lastIndexOf(NEEDLE)) {
  throw new Error('bcrypt compare export was not observed')
}

const bcrypt = require('bcryptjs')
const saved = bcrypt.compare
if (typeof saved !== 'function') throw new Error('bcrypt compare export was not observed')

function compare(password, hashValue, callback, progressCallback) {
  observe()
  return Reflect.apply(saved, this, arguments)
}

bcrypt.compare = compare

const loaderPath = path.join(__dirname, 'security-action-audit-bcrypt-observer-load.mjs')
if (!fs.existsSync(loaderPath)) throw new Error('compare observer missing')

try {
  register(pathToFileURL(loaderPath).href, {
    parentURL: pathToFileURL(__filename).href,
    data: { esmUrl },
  })
} catch (_error) {
  throw new Error('compare observer missing')
}
