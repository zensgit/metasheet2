import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { retainWebDistAssets, validateWebDist } from './web-dist-retain-assets.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'web-assets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function dist(root, label, assets = {}) {
  const dir = path.join(root, label)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'index.html'), label)
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ label }))
  for (const [file, value] of Object.entries(assets)) {
    const target = path.join(dir, 'assets', file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
  }
  return dir
}

function snapshot(root) {
  const files = {}
  function visit(relative = '') {
    const current = path.join(root, relative)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) files[relative] = { link: fs.readlinkSync(current) }
    else if (stat.isDirectory()) for (const entry of fs.readdirSync(current).sort()) visit(path.join(relative, entry))
    else files[relative] = fs.readFileSync(current).toString('base64')
  }
  visit()
  return files
}

test('first install leaves current tree unchanged when previous dist does not exist', t => {
  const root = fixture(t), current = dist(root, 'new', { 'new.js': 'new' })
  const before = snapshot(current)
  retainWebDistAssets(path.join(root, 'missing-parent', 'previous'), current)
  assert.deepEqual(snapshot(current), before)
})

test('retains nested binary assets only and preserves current entry and source bytes', t => {
  const root = fixture(t), binary = Buffer.from([0, 255, 128, 42])
  const old = dist(root, 'old', { 'nested/font.woff2': binary, 'same.js': 'same' })
  fs.writeFileSync(path.join(old, 'old-config.json'), 'must not copy')
  const current = dist(root, 'new', { 'new.js': 'new', 'same.js': 'same' })
  const oldBefore = snapshot(old), sameBefore = fs.statSync(path.join(current, 'assets/same.js')).mtimeMs
  retainWebDistAssets(old, current)
  assert.deepEqual(fs.readFileSync(path.join(current, 'assets/nested/font.woff2')), binary)
  assert.equal(fs.readFileSync(path.join(current, 'index.html'), 'utf8'), 'new')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current, 'build-info.json'))), { label: 'new' })
  assert.equal(fs.existsSync(path.join(current, 'old-config.json')), false)
  assert.deepEqual(snapshot(old), oldBefore)
  assert.equal(fs.statSync(path.join(current, 'assets/same.js')).mtimeMs, sameBefore)
})

test('collision discovered after an otherwise copyable asset causes zero staging changes', t => {
  const root = fixture(t), old = dist(root, 'old', { 'a.js': 'copyable', 'z.js': 'old' })
  const current = dist(root, 'new', { 'z.js': 'different' }), before = snapshot(current)
  assert.throws(() => retainWebDistAssets(old, current), /collision/i)
  assert.deepEqual(snapshot(current), before)
})

for (const reverse of [false, true]) {
  test(`file/directory collision refuses before mutation (reverse=${reverse})`, t => {
    const root = fixture(t)
    const old = dist(root, 'old', reverse ? { 'x/y.js': 'nested' } : { x: 'file' })
    const current = dist(root, 'new', reverse ? { x: 'file' } : { 'x/y.js': 'nested' })
    const before = snapshot(current)
    assert.throws(() => retainWebDistAssets(old, current), /collision/i)
    assert.deepEqual(snapshot(current), before)
  })
}

test('validation is read-only even when previous assets would be retained', t => {
  const root = fixture(t), old = dist(root, 'old', { 'old.js': 'old' }), current = dist(root, 'new')
  const before = snapshot(root)
  validateWebDist(current, old)
  assert.deepEqual(snapshot(root), before)
})

test('overlap and filesystem-root targets are refused', t => {
  const root = fixture(t), current = dist(root, 'new')
  assert.throws(() => validateWebDist(current, current), /overlap/i)
  assert.throws(() => validateWebDist(current, path.join(current, 'target')), /overlap/i)
  assert.throws(() => validateWebDist(current, root), /overlap/i)
  assert.throws(() => validateWebDist(current, path.parse(root).root), /filesystem root/i)
})

test('symlink or junction in a missing target ancestor is refused', t => {
  const root = fixture(t), current = dist(root, 'new'), outside = dist(root, 'outside')
  const link = path.join(root, 'alias')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => validateWebDist(current, path.join(link, 'not-created')), /link|reparse/i)
  assert.equal(fs.existsSync(path.join(outside, 'not-created')), false)
})

test('links outside assets in the release are rejected before publisher copies them', t => {
  const root = fixture(t), old = dist(root, 'old'), current = dist(root, 'new'), outside = dist(root, 'outside')
  fs.symlinkSync(outside, path.join(current, 'root-config-link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => validateWebDist(current, old), /link|reparse/i)
})

test('raw parent traversal is rejected before lexical path normalization hides a link', t => {
  const root = fixture(t), old = dist(root, 'old'), current = dist(root, 'new')
  const outside = dist(root, 'outside')
  fs.mkdirSync(path.join(outside, 'child'))
  fs.symlinkSync(path.join(outside, 'child'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => validateWebDist(`${root}/alias/../new`, old), /traversal/i)
  assert.throws(() => validateWebDist(current, `${root}/alias/../old`), /traversal/i)
})

test('assets path cannot be a regular file and source must have an index', t => {
  const root = fixture(t), old = dist(root, 'old'), current = dist(root, 'new')
  fs.writeFileSync(path.join(old, 'assets'), 'wrong type')
  assert.throws(() => retainWebDistAssets(old, current), /assets must be a directory/i)
  fs.unlinkSync(path.join(current, 'index.html'))
  assert.throws(() => validateWebDist(current, old), /index.html/i)
})

test('CLI reached through a script-directory junction still performs retention and validation', t => {
  const root = fixture(t), old = dist(root, 'old', { 'old.js': 'old' }), current = dist(root, 'new')
  const alias = path.join(root, 'scripts-alias')
  fs.symlinkSync(path.dirname(fileURLToPath(import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const helper = path.join(alias, 'web-dist-retain-assets.mjs')
  const result = spawnSync(process.execPath, [helper, 'retain', old, current], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(path.join(current, 'assets/old.js'), 'utf8'), 'old')
  fs.writeFileSync(path.join(current, 'assets/old.js'), 'collision')
  const refused = spawnSync(process.execPath, [helper, 'validate', current, old], { encoding: 'utf8' })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /collision/i)
})
