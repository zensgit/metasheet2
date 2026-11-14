import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
// These variables select the TEST executor only; publishers have no new flags.
const shell = process.env.WEB_DIST_TEST_SHELL || 'bash'
assert.ok(['bash', 'powershell', 'pwsh'].includes(shell), `Unknown test shell: ${shell}`)
const scriptPath = path.join(repoRoot, `scripts/ops/attendance-onprem-publish-web-dist.${shell === 'bash' ? 'sh' : 'ps1'}`)
const executable = shell === 'bash'
  ? (process.env.WEB_DIST_TEST_BASH || 'bash')
  : (process.env.WEB_DIST_TEST_POWERSHELL || shell)

function fixture(t) {
  const temp = fs.realpathSync.native(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temp, 'web dist publish '))
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(temp + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function makeDist(root, label) {
  const dist = path.join(root, 'apps/web/dist')
  fs.mkdirSync(path.join(dist, 'assets/nested'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), `<html>${label}</html>`)
  fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify({ build: label }))
  fs.writeFileSync(path.join(dist, 'assets', `view-${label}1111111.js`), `export default ${JSON.stringify(label)}`)
  fs.writeFileSync(path.join(dist, 'assets/nested', `font-${label}2222222.woff2`), Buffer.from([0, 255, label.charCodeAt(0), 128]))
  fs.writeFileSync(path.join(dist, 'assets/shared-deadbeef.css'), '.shared { color: blue; }')
  return dist
}

function snapshot(root) {
  const files = {}
  function visit(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, entry.name)
      const key = relative + entry.name
      if (entry.isSymbolicLink()) files[key] = { link: fs.readlinkSync(child) }
      else if (entry.isDirectory()) visit(child, key + '/')
      else files[key] = fs.readFileSync(child).toString('base64')
    }
  }
  visit(root)
  return files
}

function publish({ root = repoRoot, source, target }) {
  const env = { ...process.env }
  // Do not let a developer's deployment variables leak into fixtures.
  delete env.WEB_DIST_SOURCE
  delete env.WEB_DIST_TARGET
  delete env.ROOT_DIR_OVERRIDE
  // PowerShell 7's module path is incompatible with a native 5.1 child.
  if (shell === 'powershell') delete env.PSModulePath
  let args
  if (shell === 'bash') {
    const portable = value => value.replaceAll('\\', '/')
    env.ROOT_DIR_OVERRIDE = portable(root)
    env.WEB_DIST_SOURCE = portable(source)
    if (target) env.WEB_DIST_TARGET = portable(target)
    args = [portable(scriptPath)]
  } else {
    args = ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-RootDir', root, '-SourceDir', source]
    if (target) args.push('-TargetDir', target)
  }
  const result = spawnSync(executable, args, { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(result.error)
  return result
}

function succeeds(options) {
  const result = publish(options)
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function refuses(options, reason) {
  const before = snapshot(options.target)
  const sourceBefore = snapshot(options.source)
  const result = publish(options)
  assert.notEqual(result.status, 0, 'publisher must refuse unsafe input')
  assert.match(result.stderr + result.stdout, reason)
  assert.deepEqual(snapshot(options.target), before, 'live files must be unchanged after refusal')
  assert.deepEqual(snapshot(options.source), sourceBefore, 'release package must remain unchanged')
}

function checkCurrent(target, label) {
  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), `<html>${label}</html>`)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'build-info.json'), 'utf8')), { build: label })
}

function checkAssets(target, release, label) {
  for (const file of [`view-${label}1111111.js`, `nested/font-${label}2222222.woff2`, 'shared-deadbeef.css']) {
    assert.deepEqual(fs.readFileSync(path.join(target, 'assets', file)), fs.readFileSync(path.join(release, 'assets', file)), file)
  }
}

test(`${shell}: first install publishes explicit target and leaves release unchanged`, t => {
  const root = fixture(t)
  const source = makeDist(path.join(root, 'release'), 'a')
  const before = snapshot(source)
  const target = path.join(root, 'nginx/apps/web/dist')
  succeeds({ source, target })
  checkCurrent(target, 'a')
  checkAssets(target, source, 'a')
  assert.deepEqual(snapshot(source), before)
})

for (const layout of ['packages/package', 'packages/package/package']) {
  test(`${shell}: derives target for ${layout}`, t => {
    const root = fixture(t)
    const packageRoot = path.join(root, layout)
    const source = makeDist(packageRoot, 'a')
    succeeds({ root: packageRoot, source })
    checkCurrent(path.join(root, 'apps/web/dist'), 'a')
  })
}

test(`${shell}: A to B to C and rollback retain exact old asset bytes with current entry files`, t => {
  const root = fixture(t)
  const releases = Object.fromEntries(['a', 'b', 'c'].map(label => [label, makeDist(path.join(root, label), label)]))
  const before = Object.fromEntries(Object.entries(releases).map(([label, source]) => [label, snapshot(source)]))
  const target = path.join(root, 'live/apps/web/dist')
  succeeds({ source: releases.a, target })
  fs.writeFileSync(path.join(target, 'obsolete-root-config.json'), 'must not be retained')
  for (const [label, retained] of [['b', ['a', 'b']], ['c', ['a', 'b', 'c']], ['b', ['a', 'b', 'c']]]) {
    succeeds({ source: releases[label], target })
    checkCurrent(target, label)
    for (const old of retained) {
      checkAssets(target, releases[old], old)
    }
    assert.equal(fs.existsSync(path.join(target, 'obsolete-root-config.json')), false)
  }
  for (const [label, source] of Object.entries(releases)) assert.deepEqual(snapshot(source), before[label])
})

test(`${shell}: same-name different-byte asset fails before live replacement`, t => {
  const root = fixture(t)
  const target = makeDist(path.join(root, 'live'), 'a')
  const source = makeDist(path.join(root, 'release'), 'b')
  fs.writeFileSync(path.join(source, 'assets/shared-deadbeef.css'), 'different content under immutable URL')
  refuses({ source, target }, /collis|differ|conflict/i)
})

test(`${shell}: source nested inside target is refused without losing either tree`, t => {
  const root = fixture(t)
  const target = makeDist(path.join(root, 'live'), 'a')
  const source = makeDist(path.join(target, 'release'), 'b')
  refuses({ source, target }, /overlap|contain|ancestor|nested/i)
})

test(`${shell}: target nested inside source is refused without replacing live files`, t => {
  const root = fixture(t)
  const source = makeDist(path.join(root, 'release'), 'b')
  const target = makeDist(path.join(source, 'live'), 'a')
  refuses({ source, target }, /overlap|contain|ancestor|nested/i)
})

for (const linkedTree of ['source', 'target']) {
  test(`${shell}: ${linkedTree} asset directory link is refused without following it`, t => {
    const root = fixture(t)
    const source = makeDist(path.join(root, 'release'), 'b')
    const target = makeDist(path.join(root, 'live'), 'a')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'must-stay.txt'), 'unchanged')
    fs.symlinkSync(outside, path.join(linkedTree === 'source' ? source : target, 'assets/escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const outsideBefore = snapshot(outside)
    refuses({ source, target }, /symbolic|symlink|link|reparse/i)
    assert.deepEqual(snapshot(outside), outsideBefore)
  })
}

if (shell === 'bash') {
  for (const traversed of ['source', 'target']) {
    test(`bash: ${traversed} alias followed by parent traversal is refused before publication`, t => {
      const root = fixture(t)
      const source = makeDist(path.join(root, 'source'), 'b')
      const target = makeDist(path.join(root, 'live'), 'a')
      const external = path.join(root, 'external')
      makeDist(path.join(external, 'source'), 'z')
      makeDist(path.join(external, 'live'), 'z')
      fs.mkdirSync(path.join(external, 'child'))
      fs.symlinkSync(path.join(external, 'child'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
      const originalSource = snapshot(source)
      const originalLive = snapshot(target)
      const externalBefore = snapshot(external)
      // Do not use path.join: it would erase the traversal before the public CLI sees it.
      const raw = root.replaceAll('\\', '/') + '/alias/../' + (traversed === 'source' ? 'source' : 'live') + '/apps/web/dist'
      refuses({ source: traversed === 'source' ? raw : source, target: traversed === 'target' ? raw : target }, /traversal|\.\./i)
      assert.deepEqual(snapshot(source), originalSource)
      assert.deepEqual(snapshot(target), originalLive)
      assert.deepEqual(snapshot(external), externalBefore)
    })
  }
}

test(`${shell}: missing source entry refuses before touching live files`, t => {
  const root = fixture(t)
  const source = makeDist(path.join(root, 'release'), 'b')
  const target = makeDist(path.join(root, 'live'), 'a')
  fs.unlinkSync(path.join(source, 'index.html'))
  refuses({ source, target }, /index\.html/i)
})

test(`${shell}: publishing the already-serving directory is an unchanged no-op`, t => {
  const root = fixture(t)
  const source = makeDist(root, 'a')
  const before = snapshot(source)
  succeeds({ source, target: source })
  assert.deepEqual(snapshot(source), before)
})
