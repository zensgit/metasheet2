import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { authorizePublication, verifyPackageVisibility } from './docker-publish-preflight.mjs'

const sha = 'a'.repeat(40)
const context = { eventName: 'workflow_dispatch', repository: 'zensgit/metasheet2', ref: 'refs/heads/main', sha }
const inputs = { publish_images: 'true', publish_sha: sha, expected_visibility: 'public', deploy_production: 'false' }
const root = fileURLToPath(new URL('../../', import.meta.url))
const script = fileURLToPath(new URL('./docker-publish-preflight.mjs', import.meta.url))
const names = ['metasheet2-backend', 'metasheet2-web']
const metadata = (name, visibility = 'public') => ({ name, package_type: 'container', owner: { login: 'zensgit' }, visibility })

test('push and other non-manual events cannot opt into publication', () => {
  for (const eventName of ['push', 'pull_request', 'schedule', '', undefined]) {
    assert.deepEqual(authorizePublication({ inputs }, { ...context, eventName }), { publish: false })
  }
})

test('manual publication is opt-in and deployment cannot imply publication', () => {
  for (const publish_images of [undefined, '', 'false']) {
    assert.deepEqual(authorizePublication({ inputs: { publish_images } }, context), { publish: false })
    assert.throws(() => authorizePublication({ inputs: { publish_images, deploy_production: 'true' } }, context), /PUBLISH_REQUIRED_FOR_DEPLOY/)
  }
  for (const key of ['publish_images', 'deploy_production']) {
    for (const value of [true, false, 1, 0, null, 'TRUE', ' true', 'true ', '1', 'yes', {}, []]) {
      assert.throws(() => authorizePublication({ inputs: { ...inputs, [key]: value } }, context), /PUBLISH_INVALID_BOOLEAN/)
    }
  }
})

test('publication requires the fixed repository, main, and the full exact SHA', () => {
  for (const repository of ['other/metasheet2', '', undefined]) {
    assert.throws(() => authorizePublication({ inputs }, { ...context, repository }), /PUBLISH_REPOSITORY_MISMATCH/)
  }
  for (const ref of ['refs/heads/master', 'refs/heads/feature', 'refs/tags/v1.0.0', '', undefined]) {
    assert.throws(() => authorizePublication({ inputs }, { ...context, ref }), /PUBLISH_MAIN_REQUIRED/)
  }
  for (const publish_sha of ['b'.repeat(40), sha.slice(0, 8), sha.toUpperCase(), sha + '\n', '', null, undefined]) {
    assert.throws(() => authorizePublication({ inputs: { ...inputs, publish_sha } }, context), /PUBLISH_SHA_MISMATCH/)
  }
  assert.throws(() => authorizePublication({ inputs }, { ...context, sha: 'b'.repeat(40) }), /PUBLISH_SHA_MISMATCH/)
})

test('visibility must be explicit and enum-strict', () => {
  for (const expected_visibility of ['unselected', 'internal', 'PUBLIC', 'public ', '', null, undefined]) {
    assert.throws(() => authorizePublication({ inputs: { ...inputs, expected_visibility } }, context), /PUBLISH_VISIBILITY_REQUIRED/)
    assert.throws(() => verifyPackageVisibility(expected_visibility, () => assert.fail('must not read')), /PUBLISH_VISIBILITY_REQUIRED/)
  }
  for (const visibility of ['public', 'private']) {
    assert.deepEqual(authorizePublication({ inputs: { ...inputs, expected_visibility: visibility } }, context), { publish: true, visibility })
    const reads = []
    verifyPackageVisibility(visibility, (name) => { reads.push(name); return metadata(name, visibility) })
    assert.deepEqual(reads, names)
  }
})

test('both package identities and visibilities must match; failures never echo returned values', () => {
  for (const target of names) {
    for (const replacement of [null, [], {}, { ...metadata(target), name: 'foreign' },
      { ...metadata(target), owner: { login: 'foreign' } }, { ...metadata(target), package_type: 'npm' }]) {
      assert.throws(() => verifyPackageVisibility('public', (name) => name === target ? replacement : metadata(name)),
        { message: 'PUBLISH_PACKAGE_IDENTITY_MISMATCH' })
    }
    for (const visibility of ['private', 'internal', 'PUBLIC', undefined, null]) {
      assert.throws(() => verifyPackageVisibility('public', (name) => ({ ...metadata(name), ...(name === target ? { visibility } : {}) })),
        { message: 'PUBLISH_VISIBILITY_MISMATCH' })
    }
    assert.throws(() => verifyPackageVisibility('public', (name) => {
      if (name === target) throw new Error('secret-sentinel')
      return metadata(name)
    }), { message: 'PUBLISH_PACKAGE_READ_FAILED' })
  }
})

function runCli(t, { mode = 'visibility', eventInputs = inputs, overrides = {}, responses = {}, badJson = false } = {}) {
  const tmp = path.join(root, 'tmp')
  mkdirSync(tmp, { recursive: true })
  const dir = mkdtempSync(path.join(tmp, 'docker-publish-preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const eventPath = path.join(dir, 'event.json')
  const output = path.join(dir, 'output')
  const calls = path.join(dir, 'calls')
  const fixture = path.join(dir, 'fixture.json')
  writeFileSync(eventPath, badJson ? 'secret-sentinel' : JSON.stringify({ inputs: eventInputs }))
  writeFileSync(fixture, JSON.stringify(responses))
  const gh = path.join(dir, 'gh')
  writeFileSync(gh + '.cjs', `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n')
const name = args.at(-1).split('/').at(-1)
const fixture = JSON.parse(fs.readFileSync(process.env.TEST_FIXTURE, 'utf8'))
const response = fixture[name] ?? { name, package_type: 'container', owner: { login: 'zensgit' }, visibility: 'public' }
if (response.fail) { console.error('secret-sentinel'); process.exit(1) }
if (response.badJson) { process.stdout.write('secret-sentinel'); process.exit(0) }
process.stdout.write(JSON.stringify(response))
`)
  chmodSync(gh + '.cjs', 0o755)
  symlinkSync(gh + '.cjs', gh)
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
    GITHUB_EVENT_NAME: context.eventName, GITHUB_REPOSITORY: context.repository,
    GITHUB_REF: context.ref, GITHUB_SHA: sha, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output,
    TEST_CALLS: calls, TEST_FIXTURE: fixture, ...overrides }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  const result = spawnSync(process.execPath, [script, mode], { env, encoding: 'utf8' })
  const optional = (file) => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  assert.doesNotMatch(result.stdout + result.stderr, /secret-sentinel/)
  return { ...result, output: optional(output), calls: optional(calls).trim().split('\n').filter(Boolean).map(JSON.parse) }
}

test('real CLI denies unauthorized publication before any GH call', (t) => {
  for (const eventInputs of [{}, { ...inputs, publish_images: 'false' }, { ...inputs, publish_sha: 'b'.repeat(40) }]) {
    const result = runCli(t, { eventInputs })
    assert.equal(result.status, 1)
    assert.equal(result.output, '')
    assert.deepEqual(result.calls, [])
  }
  for (const eventName of ['push', 'workflow_dispatch']) {
    const result = runCli(t, { mode: 'authorize', eventInputs: {}, overrides: { GITHUB_EVENT_NAME: eventName } })
    assert.equal(result.status, 0)
    assert.equal(result.output, 'publish_requested=false\n')
    assert.deepEqual(result.calls, [])
  }
})

test('real CLI emits authorization without metadata IO and verifies two GET responses', (t) => {
  const authorization = runCli(t, { mode: 'authorize' })
  assert.equal(authorization.status, 0)
  assert.equal(authorization.output, 'publish_requested=true\n')
  assert.deepEqual(authorization.calls, [])
  const result = runCli(t)
  assert.equal(result.status, 0)
  assert.equal(result.output, 'verified=true\n')
  assert.deepEqual(result.calls, names.map((name) => ['api', '--hostname', 'github.com', '--method', 'GET', `/users/zensgit/packages/container/${name}`]))
})

test('real CLI refuses missing packages, malformed replies and a second-package mismatch', (t) => {
  for (const [response, code] of [
    [{ fail: true }, 'PUBLISH_PACKAGE_READ_FAILED'],
    [{ badJson: true }, 'PUBLISH_PACKAGE_READ_FAILED'],
    [{ message: 'Not Found' }, 'PUBLISH_PACKAGE_IDENTITY_MISMATCH'],
    [metadata(names[1], 'private'), 'PUBLISH_VISIBILITY_MISMATCH'],
  ]) {
    const result = runCli(t, { responses: { [names[1]]: response } })
    assert.equal(result.status, 1)
    assert.equal(result.output, '')
    assert.equal(result.stderr.trim(), code)
    assert.equal(result.calls.length, 2)
  }
  const result = runCli(t, { badJson: true })
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), 'PUBLISH_PREFLIGHT_FAILED')
  assert.equal(result.output, '')
  assert.deepEqual(result.calls, [])
})
