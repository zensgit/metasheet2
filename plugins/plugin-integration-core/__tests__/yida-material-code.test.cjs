'use strict'

/* eslint-disable @typescript-eslint/no-var-requires -- This Node test is intentionally CommonJS and dynamically imports the browser ESM boundary. */
// R-71 ⑦.4 PR-1: the pure `material-code-v1` generator. The golden vectors below are FROZEN: if one of them fails, the
// generator changed and every stored draft that carries a code would stop recompiling to its plan digest. Fix the
// generator, never the vector; a new rule is a new generator id.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const modulePath = path.join(__dirname, '..', 'lib', 'yida-material-code.mjs')
const typesPath = path.join(__dirname, '..', 'lib', 'yida-material-code.d.mts')
const moduleUrl = pathToFileURL(modulePath).href
const load = (suffix = '') => import(moduleUrl + suffix)
const encode = (text) => new TextEncoder().encode(text)
const hexOf = (bytes) => Buffer.from(bytes).toString('hex')
const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const FORMAT = /^WLBH-[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/

// Synthetic keys only, shaped like the pull's makeIdempotencyKey JSON and the manual-row key.
const PULL_KEY = JSON.stringify({ projectNo: 'SYN-P001', componentSourceId: 'SYN-C001', parentSourceId: 'SYN-R001', path: ['SYN-R001', 'SYN-C001'] })
const MANUAL_KEY = 'manual:v1:rec_synthetic_0001'
const CJK_KEY = JSON.stringify({ projectNo: '合成项目-甲', componentSourceId: '合成件𠀋', parentSourceId: null, path: ['合成件𠀋'] })
const GOLDEN = [
  { keyValue: PULL_KEY, projectNo: 'SYN-P001', code: 'WLBH-0F59FC71-6536-5ABC-95A2-74264A56BE97' },
  { keyValue: MANUAL_KEY, projectNo: 'SYN-P002', code: 'WLBH-8059CD91-4A47-5F41-AFDE-0CCD524DD205' },
  { keyValue: CJK_KEY, projectNo: '合成项目-甲', code: 'WLBH-3E6CD603-9261-5669-A9AF-D5101589C0CD' },
]

// Independent reference built on node:crypto (test side only; the module must not use it).
function referenceUuidV5(namespace, nameBytes) {
  const digest = crypto.createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(nameBytes).digest()
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = digest.subarray(0, 16).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
function referenceCode(keyValue, projectNo) {
  const name = Buffer.from(JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', keyValue, projectNo]), 'utf8')
  return 'WLBH-' + referenceUuidV5('6d37f698-e75c-4b5e-8eef-b702478a1cfb', name).toUpperCase()
}

function rejects(kind) {
  return (error) => {
    assert.equal(error.name, 'YidaMaterialCodeError')
    assert.equal(error.code, `YIDA_MATERIAL_CODE_${kind}`)
    assert.equal(error.message, error.code)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(String(error.stack), /SYN-|synthetic|合成/)
    return true
  }
}

let seed = 0x5eed1234
function random() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}
function randomText(maxLength) {
  const pools = [[0x20, 0x7e], [0x4e00, 0x9fff], [0xa0, 0x2fff]]
  let text = ''
  const length = 1 + Math.floor(random() * maxLength)
  while (text.length < length) {
    const pick = random()
    if (pick < 0.1) text += String.fromCodePoint(0x10000 + Math.floor(random() * 0xfffff))
    else {
      const [lo, hi] = pools[Math.floor(random() * pools.length)]
      text += String.fromCharCode(lo + Math.floor(random() * (hi - lo + 1)))
    }
  }
  return text
}

test('frozen constants: generator id, prefix, namespace, name tag, length', async () => {
  const m = await load()
  assert.equal(m.YIDA_MATERIAL_CODE_GENERATOR, 'material-code-v1')
  assert.equal(m.YIDA_MATERIAL_CODE_PREFIX, 'WLBH-')
  assert.equal(m.YIDA_MATERIAL_CODE_NAMESPACE_V1, '6d37f698-e75c-4b5e-8eef-b702478a1cfb')
  assert.equal(m.YIDA_MATERIAL_CODE_NAME_TAG, 'metasheet.stock-prep.yida-material-code')
  assert.equal(m.YIDA_MATERIAL_CODE_NAME_VERSION, 'v1')
  assert.equal(m.YIDA_MATERIAL_CODE_LENGTH, 41)
  assert.equal(m.YIDA_MATERIAL_CODE_INPUT_MAX_UNITS, 4096)
})

test('golden vectors: material-code-v1 output is pinned byte for byte', async () => {
  const m = await load()
  for (const vector of GOLDEN) {
    assert.equal(m.generateYidaMaterialCode({ keyValue: vector.keyValue, projectNo: vector.projectNo }), vector.code)
    assert.equal(referenceCode(vector.keyValue, vector.projectNo), vector.code)
  }
})

test('name layout is the JSON array [tag, v1, keyValue, projectNo] in UTF-8', async () => {
  const m = await load()
  const name = m.yidaMaterialCodeName({ keyValue: MANUAL_KEY, projectNo: 'SYN-P002' })
  assert.equal(Buffer.from(name).toString('utf8'), '["metasheet.stock-prep.yida-material-code","v1","manual:v1:rec_synthetic_0001","SYN-P002"]')
  const cjk = m.yidaMaterialCodeName({ keyValue: CJK_KEY, projectNo: '合成项目-甲' })
  assert.deepEqual(Buffer.from(cjk), Buffer.from(JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', CJK_KEY, '合成项目-甲']), 'utf8'))
})

test('RFC 4122 / RFC 9562 UUIDv5 known answers', async () => {
  const m = await load()
  // Python docs: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
  assert.equal(m.yidaMaterialCodeUuidV5(NAMESPACE_DNS, encode('python.org')), '886313e1-3b8a-5372-9b90-0c9aee199e5d')
  // RFC 9562 Appendix A.4
  assert.equal(m.yidaMaterialCodeUuidV5(NAMESPACE_DNS, encode('www.example.com')), '2ed6657d-e927-568b-95e1-2665a8aea6a2')
  assert.throws(() => m.yidaMaterialCodeUuidV5('6BA7B810-9DAD-11D1-80B4-00C04FD430C8', encode('x')), rejects('INPUT'))
  assert.throws(() => m.yidaMaterialCodeUuidV5('not-a-uuid', encode('x')), rejects('INPUT'))
  assert.throws(() => m.yidaMaterialCodeUuidV5(NAMESPACE_DNS, 'python.org'), rejects('INPUT'))
})

test('SHA-1 FIPS 180-4 known answers and padding boundaries match node:crypto', async () => {
  const m = await load()
  const known = [
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '84983e441c3bd26ebaae4aa1f95129e5e54670f1'],
    ['a'.repeat(1000000), '34aa973cd4c4daa4f61eeb2bdbad27316534016f'],
  ]
  for (const [input, digest] of known) assert.equal(hexOf(m.yidaMaterialCodeSha1(encode(input))), digest)
  for (let length = 0; length <= 200; length += 1) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 131 + length) & 0xff)
    assert.equal(hexOf(m.yidaMaterialCodeSha1(bytes)), crypto.createHash('sha1').update(bytes).digest('hex'), `length ${length}`)
  }
  assert.throws(() => m.yidaMaterialCodeSha1('abc'), rejects('INPUT'))
})

test('10 000 random inputs (CJK, astral, long) agree with the node:crypto reference', async () => {
  const m = await load()
  for (let i = 0; i < 10000; i += 1) {
    const keyValue = randomText(i % 50 === 0 ? 4000 : 120).trim() || 'k'
    const projectNo = randomText(24).trim() || 'p'
    assert.equal(m.generateYidaMaterialCode({ keyValue, projectNo }), referenceCode(keyValue, projectNo))
  }
})

test('format: WLBH- prefix, upper case, hyphenated UUIDv5, exactly 41 characters', async () => {
  const m = await load()
  for (const vector of GOLDEN) {
    const code = m.generateYidaMaterialCode({ keyValue: vector.keyValue, projectNo: vector.projectNo })
    assert.equal(code.length, 41)
    assert.match(code, FORMAT)
    assert.equal(code, code.toUpperCase())
    assert.equal(code.slice(5).split('-').map((part) => part.length).join(','), '8,4,4,4,12')
    assert.equal(m.isYidaMaterialCodeFormat(code), true)
  }
  assert.equal(m.isYidaMaterialCodeFormat(GOLDEN[0].code.toLowerCase()), false)
  assert.equal(m.isYidaMaterialCodeFormat('WLBH-' + GOLDEN[0].code.slice(5).replace(/-/g, '')), false)
  assert.equal(m.isYidaMaterialCodeFormat(GOLDEN[0].code.replace('-5', '-4')), false)
  assert.equal(m.isYidaMaterialCodeFormat(GOLDEN[0].code + ' '), false)
  assert.equal(m.isYidaMaterialCodeFormat(null), false)
})

test('determinism and rebuild stability: same inputs, same code, across calls and fresh module instances', async () => {
  const first = await load()
  const fresh = await load('?rebuild=1')
  assert.notEqual(first, fresh)
  for (const vector of GOLDEN) {
    const input = { keyValue: vector.keyValue, projectNo: vector.projectNo }
    const reordered = { projectNo: vector.projectNo, keyValue: vector.keyValue }
    const nullProto = Object.assign(Object.create(null), input)
    const codes = [first.generateYidaMaterialCode(input), first.generateYidaMaterialCode(input),
      fresh.generateYidaMaterialCode(input), first.generateYidaMaterialCode(reordered), first.generateYidaMaterialCode(nullProto)]
    assert.deepEqual(new Set(codes), new Set([vector.code]))
  }
})

test('inputs are distinguished, never normalised: split, order, NFC/NFD, full-width digits', async () => {
  const m = await load()
  const gen = (keyValue, projectNo) => m.generateYidaMaterialCode({ keyValue, projectNo })
  const split = [gen(PULL_KEY, 'SYN-P001'), gen(PULL_KEY, 'SYN-P003')]
  assert.notEqual(split[0], split[1])
  assert.notEqual(gen('SYN-A', 'SYN-B'), gen('SYN-B', 'SYN-A'))
  assert.notEqual(gen('SYN-A","SYN-B', 'SYN-C'), gen('SYN-A', 'SYN-B","SYN-C'))
  assert.notEqual(gen('SYN-Café', 'SYN-P'), gen('SYN-Café', 'SYN-P'))
  assert.notEqual(gen('SYN-K', 'SYN-P001'), gen('SYN-K', 'SYN-P００１'))
  assert.notEqual(gen('SYN-K', 'syn-p001'), gen('SYN-K', 'SYN-P001'))
})

test('input validation: fixed codes, values-free, nothing is trimmed or rewritten', async () => {
  const m = await load()
  const gen = (input) => () => m.generateYidaMaterialCode(input)
  for (const input of [undefined, null, 'SYN-K', 42, [MANUAL_KEY, 'SYN-P'], new Map(), {},
    { keyValue: MANUAL_KEY }, { projectNo: 'SYN-P' },
    { keyValue: MANUAL_KEY, projectNo: 'SYN-P', tenantId: 'SYN-T' },
    { keyValue: MANUAL_KEY, projectNo: 'SYN-P', [Symbol('x')]: 1 },
    Object.assign(Object.create({ inherited: true }), { keyValue: MANUAL_KEY, projectNo: 'SYN-P' }),
    Object.defineProperty({ projectNo: 'SYN-P' }, 'keyValue', { enumerable: true, get: () => MANUAL_KEY }),
  ]) assert.throws(gen(input), rejects('INPUT'))

  const bad = [undefined, null, 7, '', ' SYN', 'SYN ', '　SYN', 'SYN﻿', '\tSYN', 'SY\nN', 'SY\u0000N', 'SY\u007FN',
    'SY\u0085N', 'SY\uD800N', 'SY\uDC00N', 'SYN\uD83D', '\uDE00SYN', 'x'.repeat(4097)]
  for (const value of bad) {
    assert.throws(gen({ keyValue: value, projectNo: 'SYN-P' }), rejects('KEY_VALUE'))
    assert.throws(gen({ keyValue: MANUAL_KEY, projectNo: value }), rejects('PROJECT_NO'))
  }
  for (const value of ['x', 'x'.repeat(4096), 'SY N', 'SY　N', '𠀋', '😀SYN']) {
    assert.match(m.generateYidaMaterialCode({ keyValue: value, projectNo: value }), FORMAT)
  }
  assert.equal(new m.YidaMaterialCodeError('UNKNOWN_KIND').code, 'YIDA_MATERIAL_CODE_INPUT')
})

test('module is browser-capable: no imports, no node built-ins, no I/O, no Web Crypto', () => {
  const raw = fs.readFileSync(modulePath, 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(source.length > raw.length / 2, 'comment stripping must leave the code to scan')
  assert.match(source, /export function generateYidaMaterialCode/)
  assert.doesNotMatch(source, /^\s*import\b/m)
  assert.doesNotMatch(source, /\bimport\s*\(/)
  assert.doesNotMatch(source, /\bnode:/)
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket|localStorage|indexedDB|process|Buffer|crypto|Date|Math\.random|setTimeout)\s*[.(]/)
  assert.doesNotMatch(source, /\b(?:async|await)\b/)
})

test('type declarations name every runtime export', async () => {
  const m = await load()
  const types = fs.readFileSync(typesPath, 'utf8')
  const declared = [...types.matchAll(/^export (?:const|function|class) ([A-Za-z0-9_]+)/gm)].map((match) => match[1]).sort()
  assert.deepEqual(declared, Object.keys(m).sort())
  assert.match(types, /YIDA_MATERIAL_CODE_NAMESPACE_V1: '6d37f698-e75c-4b5e-8eef-b702478a1cfb'/)
})
