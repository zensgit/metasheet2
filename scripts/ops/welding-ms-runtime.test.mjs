import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildRuntime, contract, sha256, verifyRuntime } from './welding-ms-runtime.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOOL = path.join(REPO, 'scripts/ops/welding-ms-runtime.mjs')
const TARGET = { os: 'darwin', arch: 'arm64', node: '20.20.2' }
const WINDOWS_TARGET = { os: 'win32', arch: 'x64', node: '20.20.2' }
const DEPENDENCY_ROOTS = ['node_modules', 'apps/web/node_modules', 'packages/core-backend/node_modules',
  'packages/openapi/dist-sdk/node_modules', 'packages/mssql-readonly-utils/node_modules']

function snapshot(root, directory = '', target = TARGET) {
  const rows = []
  for (const child of fs.readdirSync(path.join(root, directory)).sort()) {
    const name = directory ? `${directory}/${child}` : child
    const file = path.join(root, name), stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) rows.push({ path: name, type: 'symlink', target: target.os === 'win32' ? fs.readlinkSync(file).replaceAll('\\', '/') : fs.readlinkSync(file) })
    else if (stat.isDirectory()) rows.push({ path: name, type: 'directory' }, ...snapshot(root, name, target))
    else rows.push({ path: name, type: 'file', byte_size: stat.size, mode: stat.mode & 0o777, sha256: sha256(fs.readFileSync(file)) })
  }
  return rows
}

function fixture(t, target = TARGET) {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'welding-ms-runtime-'))
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }))
  const input = path.join(owner, 'input'), output = path.join(owner, 'output'), manifest = path.join(owner, 'pins.json')
  fs.mkdirSync(input)
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(input, name)), { recursive: true })
    fs.writeFileSync(path.join(input, name), value)
    if (target.os === 'win32') fs.chmodSync(path.join(input, name), 0o666)
  }
  const copy = (name) => write(name, fs.readFileSync(path.join(REPO, name)))
  for (const root of DEPENDENCY_ROOTS) fs.mkdirSync(path.join(input, root), { recursive: true })
  const metadata = ['package.json', 'apps/web/package.json', 'packages/core-backend/package.json',
    'packages/mssql-readonly-utils/package.json', 'packages/openapi/package.json',
    'packages/openapi/dist-sdk/package.json', 'tools/cli/package.json']
  for (const name of Object.keys(contract.plugins)) {
    copy(`plugins/${name}/plugin.json`)
    write(`plugins/${name}/${contract.plugins[name]}`, 'module.exports = { fixture: true }\n')
    if (fs.existsSync(path.join(REPO, `plugins/${name}/package.json`))) metadata.push(`plugins/${name}/package.json`)
  }
  const dependencies = new Set(['zod', 'mssql', 'pg', 'vue', 'prom-client'])
  for (const name of metadata) {
    copy(name)
    for (const dependency of Object.keys(JSON.parse(fs.readFileSync(path.join(input, name))).dependencies ?? {})) dependencies.add(dependency)
  }
  for (const dependency of dependencies) {
    if (dependency.startsWith('@types/')) {
      write(`node_modules/${dependency}/package.json`, fs.readFileSync(path.join(REPO, 'packages/core-backend/node_modules', dependency, 'package.json')))
    } else if (dependency === 'y-protocols') {
      write(`node_modules/${dependency}/package.json`, JSON.stringify({ name: dependency, exports: { './sync': './sync.cjs' } }))
      write(`node_modules/${dependency}/sync.cjs`, 'module.exports = { fixture: true }\n')
    } else {
      write(`node_modules/${dependency}/package.json`, JSON.stringify({ name: dependency, main: 'index.cjs' }))
      write(`node_modules/${dependency}/index.cjs`, 'module.exports = { fixture: true }\n')
    }
  }
  write('packages/mssql-readonly-utils/index.cjs', 'module.exports = { fixture: true }\n')
  write('packages/openapi/dist-sdk/index.js', 'export const fixture = true\n')
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', ...contract.sql,
    'scripts/ops/welding-ms-runtime.mjs', 'scripts/ops/welding-ms-runtime-contract.json']) copy(file)
  for (const file of ['apps/web/dist/index.html', 'packages/core-backend/dist/src/db/migrate.js',
    'packages/core-backend/dist/src/db/migration-provider.js', 'packages/core-backend/dist/src/db/migrations/fixture.js',
    'packages/core-backend/dist/src/routes/welding.js', 'packages/core-backend/dist/src/routes/welding-cad-host.js']) write(file, '// fixture\n')
  write('packages/core-backend/dist/src/index.js', "console.log(JSON.stringify({express:require('express').fixture,workspace:require('@metasheet/mssql-readonly-utils').fixture}))\n")
  const node = target.os === 'win32' ? 'runtime/node.exe' : 'runtime/node'
  write(node, 'synthetic Node bytes; never executed\n')
  fs.chmodSync(path.join(input, node), target.os === 'win32' ? 0o666 : 0o755)
  const link = (name, target) => {
    fs.mkdirSync(path.dirname(path.join(input, name)), { recursive: true })
    fs.symlinkSync(path.relative(path.dirname(path.join(input, name)), path.join(input, target)), path.join(input, name), fs.statSync(path.join(input, target)).isDirectory() ? 'dir' : 'file')
  }
  // Exercise real pnpm-style storage, importer links and a workspace directory.
  fs.mkdirSync(path.join(input, 'node_modules/.pnpm/express/node_modules'), { recursive: true })
  fs.renameSync(path.join(input, 'node_modules/express'), path.join(input, 'node_modules/.pnpm/express/node_modules/express'))
  link('node_modules/express', 'node_modules/.pnpm/express/node_modules/express')
  fs.rmSync(path.join(input, 'node_modules/@metasheet/core-backend'), { recursive: true })
  link('node_modules/@metasheet/core-backend', 'packages/core-backend')
  link('packages/core-backend/node_modules/@metasheet/mssql-readonly-utils', 'packages/mssql-readonly-utils')
  for (const [plugin, dependency] of [['plugin-attendance', 'zod'], ['plugin-integration-core', 'mssql'],
    ['plugin-integration-core', 'pg'], ['plugin-integration-core', '@metasheet/mssql-readonly-utils'],
    ['plugin-intelligent-restore', 'vue'], ['plugin-telemetry-otel', 'prom-client']]) {
    link(`plugins/${plugin}/node_modules/${dependency}`, dependency === '@metasheet/mssql-readonly-utils'
      ? 'packages/mssql-readonly-utils' : `node_modules/${dependency}`)
  }
  const freeze = (mutate = () => {}) => {
    const value = { schema: 'metasheet.welding_ms_runtime/1', profile: 'root-cwd13', target, files: snapshot(input, '', target) }
    mutate(value)
    const raw = `${JSON.stringify(value)}\n`
    fs.writeFileSync(manifest, raw)
    return { input, output, manifest, manifestSha256: sha256(raw) }
  }
  return { input, output, manifest, write, freeze }
}

test('root13 runtime builds and verifies cold without the original input', (t) => {
  const f = fixture(t), pins = f.freeze(), before = snapshot(f.input)
  const built = spawnSync(process.execPath, [TOOL, 'build', '--input', f.input, '--output', f.output,
    '--manifest', f.manifest, '--manifest-sha256', pins.manifestSha256], { encoding: 'utf8', timeout: 10000 })
  assert.equal(built.status, 0, built.stderr)
  assert.equal(JSON.parse(built.stdout).installed_runtime, 'not_verified')
  assert.deepEqual(snapshot(f.input), before)
  fs.renameSync(f.input, `${f.input}-unavailable`)
  const verified = spawnSync(process.execPath, [path.join(f.output, 'scripts/ops/welding-ms-runtime.mjs'),
    'verify', '--root', f.output, '--manifest-sha256', pins.manifestSha256], { encoding: 'utf8', timeout: 10000 })
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(JSON.parse(verified.stdout).launch.plugins.length, 13)
  const probe = spawnSync(process.execPath, [path.join(f.output, 'packages/core-backend/dist/src/index.js')], { cwd: f.output, encoding: 'utf8', timeout: 10000 })
  assert.equal(probe.status, 0, probe.stderr)
  assert.deepEqual(JSON.parse(probe.stdout), { express: true, workspace: true })
})

for (const [name, damage, expected] of [
  ['missing SQL', (f) => fs.unlinkSync(path.join(f.input, contract.sql[0])), /Required runtime file missing/],
  ['missing workspace utility', (f) => fs.unlinkSync(path.join(f.input, 'packages/mssql-readonly-utils/index.cjs')), /Required runtime file missing/],
  ['missing plugin package metadata', (f) => fs.unlinkSync(path.join(f.input, contract.pluginPackages[0])), /Required runtime file missing/],
  ['missing dependency', (f) => fs.rmSync(path.join(f.input, 'node_modules/express')), /Cannot find module 'express'/],
  ['missing plugin importer', (f) => fs.unlinkSync(path.join(f.input, 'plugins/plugin-intelligent-restore/node_modules/vue')), /Plugin importer link missing/],
  ['escaping link', (f) => { fs.unlinkSync(path.join(f.input, 'node_modules/express')); fs.symlinkSync('../../outside', path.join(f.input, 'node_modules/express')) }, /Unsafe member path/],
  ['dangling link', (f) => fs.rmSync(path.join(f.input, 'node_modules/.pnpm/express/node_modules/express'), { recursive: true }), /Link target absent/],
  ['TS plugin entry', (f) => { const file = 'plugins/hello-world/plugin.json'; const value = JSON.parse(fs.readFileSync(path.join(f.input, file))); value.main = 'src/index.ts'; f.write(file, JSON.stringify(value)) }, /Plugin entry\/profile changed/],
]) {
  for (const target of [TARGET, WINDOWS_TARGET]) {
    test(`root13 runtime ${target.os} refuses ${name} after fresh input hashing`, (t) => {
      const f = fixture(t, target)
      damage(f)
      assert.throws(() => buildRuntime(f.freeze()), expected)
      assert.equal(fs.existsSync(f.output), false)
    })
  }
}

test('unlisted dependency bytes cannot fall back to the original input filesystem', (t) => {
  const f = fixture(t)
  const pins = f.freeze((value) => { value.files = value.files.filter((row) => row.path !== 'node_modules/.pnpm/express/node_modules/express/index.cjs') })
  assert.throws(() => buildRuntime(pins), /Dependency escapes frozen closure: express/)
  assert.equal(fs.existsSync(f.output), false)
})

test('backend dependency with subpath-only exports uses its actual sync entry', (t) => {
  const f = fixture(t)
  f.write('node_modules/y-protocols/package.json', JSON.stringify({ name: 'y-protocols', exports: { './sync': './sync.cjs' } }))
  f.write('node_modules/y-protocols/sync.cjs', 'module.exports = { fixture: true }\n')
  const pins = f.freeze()
  buildRuntime(pins)
  assert.equal(verifyRuntime(f.output, pins.manifestSha256).root_backend_declared_direct_dependencies, 'resolvable')
})

test('backend dependency refuses a missing sync subpath even with an index file', (t) => {
  const f = fixture(t)
  f.write('node_modules/y-protocols/package.json', JSON.stringify({ name: 'y-protocols', exports: { './sync': './sync.cjs' } }))
  fs.unlinkSync(path.join(f.input, 'node_modules/y-protocols/sync.cjs'))
  f.write('node_modules/y-protocols/index.cjs', 'module.exports = { fixture: true }\n')
  assert.throws(() => buildRuntime(f.freeze()), /Cannot find module .*sync\.cjs/)
  assert.equal(fs.existsSync(f.output), false)
})

test('backend dependency cannot resolve an unlisted sync entry from the input', (t) => {
  const f = fixture(t)
  f.write('node_modules/y-protocols/package.json', JSON.stringify({ name: 'y-protocols', exports: { './sync': './sync.cjs' } }))
  f.write('node_modules/y-protocols/sync.cjs', 'module.exports = { fixture: true }\n')
  const pins = f.freeze((value) => { value.files = value.files.filter((row) => row.path !== 'node_modules/y-protocols/sync.cjs') })
  assert.throws(() => buildRuntime(pins), /Dependency escapes frozen closure: y-protocols\/sync/)
  assert.equal(fs.existsSync(f.output), false)
})

test('existing output and its data are preserved', (t) => {
  const f = fixture(t), pins = f.freeze()
  fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, 'data'), 'keep')
  assert.throws(() => buildRuntime(pins), /Destination exists/)
  assert.equal(fs.readFileSync(path.join(f.output, 'data'), 'utf8'), 'keep')
})

test('byte changes and wrong input manifest pins are refused', (t) => {
  const f = fixture(t), pins = f.freeze()
  assert.throws(() => buildRuntime({ ...pins, manifestSha256: '0'.repeat(64) }), /manifest SHA256 changed/)
  fs.appendFileSync(path.join(f.input, contract.sql[0]), '\nchanged')
  assert.throws(() => buildRuntime(pins), /File bytes\/mode changed/)
  assert.equal(fs.existsSync(f.output), false)
})

test('rehashed output cannot omit required SQL', (t) => {
  const f = fixture(t), pins = f.freeze()
  buildRuntime(pins)
  const file = path.join(f.output, 'welding-ms-runtime-manifest.json')
  const value = JSON.parse(fs.readFileSync(file))
  value.files = value.files.filter((row) => row.path !== contract.sql[0])
  fs.unlinkSync(path.join(f.output, contract.sql[0]))
  const raw = JSON.stringify(value); fs.writeFileSync(file, raw)
  assert.throws(() => verifyRuntime(f.output, sha256(raw)), /Required runtime file missing/)
})

test('backend-cwd15 is refused instead of claiming TS plugin qualification', (t) => {
  const f = fixture(t)
  assert.throws(() => buildRuntime(f.freeze((manifest) => { manifest.profile = 'backend-cwd15' })), /Unsupported runtime manifest\/profile/)
  assert.equal(fs.existsSync(f.output), false)
})

test('legitimate parent aliases keep closed links resolvable', (t) => {
  const f = fixture(t), pins = f.freeze()
  const owner = path.dirname(f.input), alias = path.join(owner, 'alias')
  fs.symlinkSync(owner, alias)
  const output = path.join(alias, 'output')
  buildRuntime({ ...pins, input: path.join(alias, 'input'), output })
  assert.equal(verifyRuntime(output, pins.manifestSha256).members, snapshot(f.input).length)
})

test('an intermediate physical directory cannot redirect frozen links outside the input', (t) => {
  const f = fixture(t), pins = f.freeze()
  const directory = path.join(f.input, 'node_modules/.pnpm/express/node_modules')
  const outside = path.join(path.dirname(f.input), 'outside')
  fs.renameSync(directory, outside)
  fs.symlinkSync(outside, directory)
  assert.throws(() => buildRuntime(pins), /Directory changed/)
  assert.equal(fs.existsSync(f.output), false)
})

test('input and output roots themselves cannot be symbolic links', (t) => {
  const f = fixture(t), pins = f.freeze(), owner = path.dirname(f.input)
  const inputLink = path.join(owner, 'input-link'), outputLink = path.join(owner, 'output-link')
  fs.symlinkSync(f.input, inputLink)
  assert.throws(() => buildRuntime({ ...pins, input: inputLink }), /physical directory/)
  buildRuntime(pins)
  fs.symlinkSync(f.output, outputLink)
  assert.throws(() => verifyRuntime(outputLink, pins.manifestSha256), /physical directory/)
})

test('unlisted output files are refused', (t) => {
  const f = fixture(t), pins = f.freeze()
  buildRuntime(pins)
  fs.writeFileSync(path.join(f.output, 'node_modules/extra'), 'unfrozen')
  assert.throws(() => verifyRuntime(f.output, pins.manifestSha256), /Runtime namespace changed/)
})

test('win32 runtime builds with relative directory and file links and relocates cold', (t) => {
  const f = fixture(t, WINDOWS_TARGET)
  f.write('node_modules/probe-leaf/data.cjs', 'module.exports = 42\n')
  fs.symlinkSync('probe-leaf/data.cjs', path.join(f.input, 'node_modules/file-probe.cjs'), 'file')
  if (process.platform === 'win32') {
    assert.equal(process.versions.node, WINDOWS_TARGET.node)
    assert.equal(process.arch, WINDOWS_TARGET.arch)
    fs.copyFileSync(process.execPath, path.join(f.input, 'runtime/node.exe'))
  }
  const pins = f.freeze(), before = snapshot(f.input, '', WINDOWS_TARGET)
  const built = buildRuntime(pins)
  assert.deepEqual(built.declared_target, WINDOWS_TARGET)
  assert.equal(built.installed_runtime, 'not_verified')
  assert.deepEqual(snapshot(f.input, '', WINDOWS_TARGET), before)
  fs.renameSync(f.input, `${f.input}-unavailable`)
  const moved = path.join(path.dirname(f.output), 'relocated with spaces')
  fs.renameSync(f.output, moved)
  const verified = spawnSync(process.execPath, [path.join(moved, 'scripts/ops/welding-ms-runtime.mjs'),
    'verify', '--root', moved, '--manifest-sha256', pins.manifestSha256], { encoding: 'utf8', timeout: 10000 })
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(JSON.parse(verified.stdout).installed_runtime, 'not_verified')
  const probe = spawnSync(process.execPath, ['-e', "console.log(require('./node_modules/file-probe.cjs'))"],
    { cwd: moved, encoding: 'utf8', timeout: 10000 })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout.trim(), '42')
  if (process.platform === 'win32') {
    const owned = spawnSync(path.join(moved, 'runtime/node.exe'), ['-p',
      'JSON.stringify({os:process.platform,arch:process.arch,node:process.versions.node})'],
    { cwd: moved, encoding: 'utf8', timeout: 10000 })
    assert.equal(owned.status, 0, owned.stderr)
    assert.deepEqual(JSON.parse(owned.stdout), WINDOWS_TARGET)
  }
})

test('win32 runtime preserves mode, bytes and required executable filename checks', (t) => {
  const f = fixture(t, WINDOWS_TARGET)
  assert.throws(() => buildRuntime(f.freeze(value => {
    value.files.find(row => row.path === 'runtime/node.exe').mode = 0o444
  })), /File bytes\/mode changed/)
  const pins = f.freeze()
  fs.appendFileSync(path.join(f.input, contract.sql[0]), '\nchanged')
  assert.throws(() => buildRuntime(pins), /File bytes\/mode changed/)
  fs.renameSync(path.join(f.input, 'runtime/node.exe'), path.join(f.input, 'runtime/node'))
  assert.throws(() => buildRuntime(f.freeze()), /Unexpected.*runtime\/node|Required runtime file missing/)
  assert.equal(fs.existsSync(f.output), false)
})

test('darwin runtime retains executable-bit and exact mode requirements', (t) => {
  const f = fixture(t)
  fs.chmodSync(path.join(f.input, 'runtime/node'), 0o666)
  assert.throws(() => buildRuntime(f.freeze()), /Owned Node input must be executable/)
  fs.chmodSync(path.join(f.input, 'runtime/node'), 0o755)
  assert.throws(() => buildRuntime(f.freeze(value => {
    value.files.find(row => row.path === contract.sql[0]).mode ^= 0o200
  })), /File bytes\/mode changed/)
})

test('win32 runtime rejects absolute links even when they resolve inside the input', (t) => {
  const f = fixture(t, WINDOWS_TARGET), link = path.join(f.input, 'node_modules/express')
  fs.unlinkSync(link)
  fs.symlinkSync(path.join(f.input, 'node_modules/.pnpm/express/node_modules/express'), link, 'dir')
  assert.throws(() => buildRuntime(f.freeze()), /Invalid relative link/)
  assert.equal(fs.existsSync(f.output), false)
})

test('win32 runtime preserves dependency closure and output namespace rejection', (t) => {
  const f = fixture(t, WINDOWS_TARGET)
  assert.throws(() => buildRuntime(f.freeze(value => {
    value.files = value.files.filter(row => row.path !== 'node_modules/.pnpm/express/node_modules/express/index.cjs')
  })), /Dependency escapes frozen closure/)
  const pins = f.freeze()
  buildRuntime(pins)
  fs.writeFileSync(path.join(f.output, 'node_modules/extra'), 'unfrozen')
  assert.throws(() => verifyRuntime(f.output, pins.manifestSha256), /Runtime namespace changed/)
})

for (const target of [
  { ...WINDOWS_TARGET, arch: 'arm64' }, { ...WINDOWS_TARGET, node: '22.0.0' },
  { ...TARGET, arch: 'x64' }, { ...TARGET, os: 'linux' },
]) {
  test(`runtime refuses unsupported target ${target.os}/${target.arch}/${target.node}`, (t) => {
    const f = fixture(t)
    assert.throws(() => buildRuntime(f.freeze(value => { value.target = target })), /byte profile/)
    assert.equal(fs.existsSync(f.output), false)
  })
}
