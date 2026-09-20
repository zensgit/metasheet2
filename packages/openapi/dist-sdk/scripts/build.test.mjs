import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveBin, runBuild } from './build.mjs'

function makeFakePackage(dir, name, bin) {
  const pkgDir = path.join(dir, name)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, bin }),
  )
  return pkgDir
}

test('resolveBin returns the absolute path from a string "bin" field', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'))
  try {
    const pkgDir = makeFakePackage(tmp, 'fake-pkg', './cli.js')
    fs.writeFileSync(path.join(pkgDir, 'cli.js'), '// noop')
    const fakeRequire = (specifier) => {
      assert.equal(specifier, 'fake-pkg/package.json')
      return path.join(pkgDir, 'package.json')
    }
    const resolved = resolveBin('fake-pkg', 'fake-pkg', { requireFn: fakeRequire })
    assert.equal(resolved, path.join(pkgDir, 'cli.js'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveBin returns the absolute path from an object "bin" map, keyed by binName', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'))
  try {
    const pkgDir = makeFakePackage(tmp, 'fake-multi-bin', {
      'fake-multi-bin': './bin/main.js',
      'fake-multi-bin-tool': './bin/tool.js',
    })
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'bin', 'tool.js'), '// noop')
    const fakeRequire = () => path.join(pkgDir, 'package.json')
    const resolved = resolveBin('fake-multi-bin', 'fake-multi-bin-tool', {
      requireFn: fakeRequire,
    })
    assert.equal(resolved, path.join(pkgDir, 'bin', 'tool.js'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveBin throws a clear error when the package cannot be resolved', () => {
  const fakeRequire = () => {
    throw new Error('Cannot find module')
  }
  assert.throws(
    () => resolveBin('missing-pkg', 'missing-pkg', { requireFn: fakeRequire }),
    /Cannot resolve package "missing-pkg"/,
  )
})

test('resolveBin throws a clear error when the package has no matching bin entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'))
  try {
    const pkgDir = makeFakePackage(tmp, 'fake-no-bin', undefined)
    const fakeRequire = () => path.join(pkgDir, 'package.json')
    assert.throws(
      () => resolveBin('fake-no-bin', 'fake-no-bin', { requireFn: fakeRequire }),
      /no matching "bin" entry/,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('runBuild invokes both CLIs via process.execPath with the resolved absolute path as argv[0], with no shell', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'))
  try {
    const cwd = path.join(tmp, 'pkg', 'dist-sdk')
    const distDir = path.join(tmp, 'pkg', 'dist')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(path.join(distDir, 'openapi.yaml'), 'openapi: 3.0.0\n')

    const calls = []
    const fakeExecFile = (command, args, options) => {
      calls.push({ command, args, options })
      // Simulate openapi-typescript / tsc writing their outputs.
      if (args.includes('--output')) {
        fs.writeFileSync(path.join(cwd, 'index.d.ts'), 'export {}\n')
      }
    }
    const fakeResolveBin = (pkgName, binName = pkgName) =>
      path.join(tmp, 'bins', `${binName}.js`)

    runBuild({ cwd, execFile: fakeExecFile, resolveBinFn: fakeResolveBin })

    assert.equal(calls.length, 2)

    for (const call of calls) {
      assert.equal(
        call.command,
        process.execPath,
        'each CLI must be invoked via the current Node binary, not a package-manager shim',
      )
      assert.ok(
        path.isAbsolute(call.args[0]),
        'argv[0] passed to execFile must be the resolved absolute CLI path',
      )
      assert.ok(
        !('shell' in call.options) || call.options.shell === false,
        'execFile must not be invoked with shell: true',
      )
    }

    assert.equal(calls[0].args[0], path.join(tmp, 'bins', 'openapi-typescript.js'))
    assert.equal(calls[1].args[0], path.join(tmp, 'bins', 'tsc.js'))

    // index.js stub is written directly by runBuild, independent of the
    // (faked) CLI invocations.
    assert.ok(fs.existsSync(path.join(cwd, 'index.js')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('runBuild throws a clear error when openapi.yaml is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'))
  try {
    const cwd = path.join(tmp, 'pkg', 'dist-sdk')
    fs.mkdirSync(cwd, { recursive: true })
    // Note: tmp/pkg/dist/openapi.yaml intentionally not created.

    assert.throws(
      () =>
        runBuild({
          cwd,
          execFile: () => {
            throw new Error('execFile should not be called')
          },
          resolveBinFn: () => {
            throw new Error('resolveBinFn should not be called')
          },
        }),
      /openapi\.yaml not found/,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
