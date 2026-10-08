import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const yaml = createRequire(import.meta.url)('js-yaml')
const raw = readFileSync(new URL('../../.github/workflows/docker-build.yml', import.meta.url), 'utf8')
const workflow = yaml.load(raw)
const build = workflow.jobs.build
const step = (id) => build.steps.find((entry) => entry.id === id)
const verified = "${{ steps.publish_preflight.outputs.verified == 'true' }}"
const requested = "${{ steps.publish_authorization.outputs.publish_requested == 'true' }}"

test('publication defaults off and requires an explicit SHA and visibility selection', () => {
  assert.equal(workflow.name, 'Build and Push Docker Images')
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.deepEqual(inputs.publish_images, {
    description: 'Explicitly authorize publishing images for publish_sha',
    required: true, type: 'boolean', default: false,
  })
  assert.equal(inputs.publish_sha.type, 'string')
  assert.equal(inputs.expected_visibility.default, 'unselected')
  assert.deepEqual(inputs.expected_visibility.options, ['unselected', 'public', 'private'])
  assert.equal(inputs.deploy_production.default, false)
  assert.equal(step('publish_authorization').run, 'node scripts/ops/docker-publish-preflight.mjs authorize')
  assert.equal(step('publish_authorization').if, undefined)
  assert.equal(step('publish_authorization').env, undefined)
})

test('both builds precede the visibility preflight and contain no registry write', () => {
  const builds = build.steps.filter((entry) => /docker build /.test(entry.run ?? ''))
  assert.equal(builds.length, 2)
  for (const entry of builds) {
    assert.equal(entry.if, undefined)
    assert.doesNotMatch(entry.run, /docker (push|login)|--push/)
    assert.match(entry.run, /--build-arg VCS_REF="\$\{GITHUB_SHA\}"/)
    assert.match(entry.run, /--build-arg BUILD_IMAGE_TAG="\$\{GITHUB_SHA\}"/)
    assert.ok(build.steps.indexOf(entry) < build.steps.indexOf(step('publish_preflight')))
  }
  assert.equal(step('publish_preflight').if, requested)
  assert.equal(step('publish_preflight').run, 'node scripts/ops/docker-publish-preflight.mjs visibility')
  assert.deepEqual(step('publish_preflight').env, { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' })
  assert.equal(step('publish_preflight')['continue-on-error'], undefined)
})

test('every registry login and push is fenced by successful preflight', () => {
  const writes = build.steps.filter((entry) => /docker\/login-action|docker (push|login)|--push/.test((entry.uses ?? '') + (entry.run ?? '')))
  assert.equal(writes.length, 2)
  for (const entry of writes) {
    assert.equal(entry.if, verified)
    assert.equal(entry['continue-on-error'], undefined)
    assert.ok(build.steps.indexOf(entry) > build.steps.indexOf(step('publish_preflight')))
  }
  const publish = step('publish_images').run
  assert.match(publish, /^set -euo pipefail\n/)
  assert.deepEqual(publish.split('\n').filter((line) => line.startsWith('docker push ')), [
    'docker push "ghcr.io/zensgit/metasheet2-backend:${GITHUB_SHA}"',
    'docker push "ghcr.io/zensgit/metasheet2-web:${GITHUB_SHA}"',
    'docker push ghcr.io/zensgit/metasheet2-backend:latest',
    'docker push ghcr.io/zensgit/metasheet2-web:latest',
  ])
  assert.ok(publish.lastIndexOf('docker push ') < publish.indexOf('echo "published=true"'))
  assert.doesNotMatch(publish, /\|\|\s*true|continue-on-error/)
  assert.doesNotMatch(raw, /Set packages to private|visibility=private|--method PATCH/)
})

test('deployment retains its independent gate and requires completed publication', () => {
  assert.deepEqual(build.outputs, { published: '${{ steps.publish_images.outputs.published }}' })
  assert.equal(workflow.jobs.deploy.needs, 'build')
  assert.equal(workflow.jobs.deploy.if,
    "${{ github.event_name == 'workflow_dispatch' && inputs.deploy_production == true && github.ref == 'refs/heads/main' && needs.build.outputs.published == 'true' }}")
})

test('the actual publish shell stops at each failed push and emits success only after all four', (t) => {
  const root = fileURLToPath(new URL('../../tmp/', import.meta.url))
  mkdirSync(root, { recursive: true })
  for (const failure of [0, 1, 2, 3, 4]) {
    const dir = mkdtempSync(path.join(root, 'docker-publish-shell-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const calls = path.join(dir, 'calls')
    const output = path.join(dir, 'output')
    const stub = path.join(dir, 'docker')
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\n[ "$(wc -l < "$TEST_CALLS" | tr -d " ")" != "$TEST_FAIL_AT" ]\n')
    chmodSync(stub, 0o755)
    const result = spawnSync('bash', ['-c', step('publish_images').run], { encoding: 'utf8',
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
        GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: output, TEST_CALLS: calls, TEST_FAIL_AT: String(failure) },
    })
    assert.equal(result.status, failure === 0 ? 0 : 1)
    const actual = readFileSync(calls, 'utf8').trim().split('\n')
    assert.equal(actual.length, failure || 4)
    assert.equal(actual[0], 'push ghcr.io/zensgit/metasheet2-backend:' + 'a'.repeat(40))
    if (failure === 0) assert.equal(readFileSync(output, 'utf8'), 'published=true\n')
    else assert.throws(() => readFileSync(output), { code: 'ENOENT' })
  }
})

test('PR and ordinary build paths execute publication safety tests', () => {
  const guard = yaml.load(readFileSync(new URL('../../.github/workflows/docker-publish-guard.yml', import.meta.url), 'utf8'))
  assert.ok(Object.hasOwn(guard.on, 'pull_request'))
  assert.equal(guard.on.pull_request, null)
  assert.deepEqual(guard.permissions, { contents: 'read' })
  assert.ok(guard.on.push.paths.includes('.github/workflows/docker-build.yml'))
  assert.ok(guard.on.push.paths.includes('scripts/ops/docker-publish-*.mjs'))
  const command = guard.jobs.guard.steps.find((entry) => entry.name === 'Test publication and deployment contracts').run
  for (const file of ['docker-publish-preflight.test.mjs', 'docker-publish-workflow-contract.test.mjs', 'deploy-immutable-traceability-contract.test.mjs', 'integration-erp-plm-deploy-readiness.test.mjs']) {
    assert.ok(command.includes('scripts/ops/' + file))
  }
  assert.ok(build.steps.some((entry) => entry.run === 'node --test scripts/ops/docker-publish-preflight.test.mjs'))
})
