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
  for (const file of ['docker-publish-preflight.test.mjs', 'docker-publish-workflow-contract.test.mjs', 'deploy-immutable-traceability-contract.test.mjs', 'integration-erp-plm-deploy-readiness.test.mjs', 'docker-build-prod-window.test.mjs', 'remote-summary-pipefail-contract.test.mjs']) {
    assert.ok(command.includes('scripts/ops/' + file))
  }
  for (const watched of ['scripts/ops/docker-build-prod-window.test.mjs', 'scripts/ops/fixtures/docker-build-prod-window/**', 'scripts/ops/remote-summary-pipefail-contract.test.mjs']) {
    assert.ok(guard.on.push.paths.includes(watched), `guard push paths include ${watched}`)
  }
  assert.ok(build.steps.some((entry) => entry.run === 'node --test scripts/ops/docker-publish-preflight.test.mjs'))
})

test('production deploy inputs, validation step, concurrency and timeouts of the deploy window', () => {
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.equal(inputs.restore_proof.default, 'unselected')
  assert.equal(inputs.pre_commit_abort.type, 'choice')
  assert.deepEqual(inputs.pre_commit_abort.options, ['unselected', 'restart-old', 'stay-stopped'])
  assert.equal(inputs.pre_commit_abort.default, 'unselected')
  assert.equal(inputs.drill_fail_stage.type, 'choice')
  assert.deepEqual(inputs.drill_fail_stage.options, ['none', 'deploy', 'migrate'])
  assert.equal(inputs.expected_pending_sha256.type, 'string')
  assert.ok(!Object.hasOwn(inputs, 'migration_exclude'), 'the exclusion set is a committed constant, never an input')
  assert.ok(!Object.keys(inputs).some((name) => /exclude/i.test(name)))

  const deploy = workflow.jobs.deploy
  assert.deepEqual(deploy.concurrency, { group: 'metasheet2-production-deploy', 'cancel-in-progress': false })
  assert.equal(typeof deploy['timeout-minutes'], 'number')
  assert.ok(deploy['timeout-minutes'] > 0)
  const remote = deploy.steps.find((entry) => entry.id === 'remote_deploy')
  assert.ok(remote)
  assert.equal(typeof remote['timeout-minutes'], 'number')
  assert.ok(remote['timeout-minutes'] > 0 && remote['timeout-minutes'] < deploy['timeout-minutes'])

  const validate = step('validate_deploy_inputs')
  assert.ok(validate, 'build has a validate_deploy_inputs step')
  assert.equal(validate.if, '${{ inputs.deploy_production == true }}')
  assert.equal(validate['continue-on-error'], undefined)
  assert.equal(validate.uses, undefined)
  assert.doesNotMatch(validate.run, /docker build |docker push|docker login|--push/)
  const builds = build.steps.filter((entry) => /docker build /.test(entry.run ?? ''))
  assert.equal(builds.length, 2)
  for (const entry of builds) {
    assert.ok(build.steps.indexOf(validate) < build.steps.indexOf(entry), 'validation runs before both image builds')
  }
  for (const entry of build.steps.filter((item) => /docker\/login-action|docker (push|login)|--push/.test((item.uses ?? '') + (item.run ?? '')))) {
    assert.ok(build.steps.indexOf(validate) < build.steps.indexOf(entry), 'validation runs before every registry write')
  }
})

test('validate_deploy_inputs reads each value from its dispatch input or repository variable', () => {
  const tunables = {
    DEPLOY_WINDOW_PULL_BUDGET_KB: '3145728',
    DEPLOY_WINDOW_RESERVE_KB: '2097152',
    DEPLOY_BACKUP_TIMEOUT_S: '1200',
    DEPLOY_BACKUP_VERIFY_TIMEOUT_S: '900',
    DEPLOY_WINDOW_EXPECTED_MIN: '90',
    DEPLOY_WINDOW_DRAIN_S: '60',
    DEPLOY_WINDOW_QUEUED_MAX_AGE_S: '86400',
    DEPLOY_WINDOW_MIN_HOST_CHECKS: '1',
    DEPLOY_WINDOW_CANCEL_OWN_SESSIONS: 'false',
  }
  const expected = {
    DRILL_FAIL_STAGE: '${{ inputs.drill_fail_stage }}',
    EXPECTED_PENDING_SHA256: '${{ inputs.expected_pending_sha256 }}',
    RESTORE_PROOF: '${{ inputs.restore_proof }}',
    PRE_COMMIT_ABORT: '${{ inputs.pre_commit_abort }}',
    PROD_HEALTH_PROBE_SILENCE: "${{ vars.PROD_HEALTH_PROBE_SILENCE || '' }}",
  }
  for (const [name, fallback] of Object.entries(tunables)) expected[name] = `\${{ vars.${name} || '${fallback}' }}`
  assert.deepEqual(step('validate_deploy_inputs').env, expected, 'no value is hard-wired in the validation step')
  // The window receives the same tunables with the same defaults.
  const remote = workflow.jobs.deploy.steps.find((entry) => entry.id === 'remote_deploy')
  for (const name of Object.keys(tunables)) assert.equal(remote.env[name], expected[name], `remote_deploy env ${name}`)
})

// The deploy window status step: one more ssh session that only reads host files. The checks
// run on the remote payload (the quoted WINDOW_STATUS heredoc); the runner side legitimately
// writes its own ~/.ssh files and the step's log file.
const STATUS_ALLOWED_LINE = [
  /^set -u$/,
  /^status_home="\$\{HOME\}\/metasheet2-deploy-window"$/,
  /^status_run_dir="\$\{status_home\}\/runs\/\$\{WINDOW_RUN\}"$/,
  /^echo "[^"`;|&<>]*"$/,
  /^if \[ -r "[^"`;|&<>$]*(\$\{status_(home|run_dir)\}[^"`;|&<>$]*)"? \]; then$/,
  // sed only as a print filter: -n, no -i, each program one s#…#…#p (no w/e command or flag).
  /^sed -n -E (-e )?'s#[^#']*#[^#']*#p'( -e 's#[^#']*#[^#']*#p')* "\$\{status_(home|run_dir)\}\/(state|rc|window\.log)"$/,
  /^else$/,
  /^fi$/,
  /^exit 0$/,
]
const STATUS_FORBIDDEN = /\b(docker|compose|rm|mv|cp|mkdir|touch|chmod|chown|ln|dd|truncate|install|tee|kill|pkill|flock|git|nohup|setsid|bash|sh|eval|source|exec|systemctl|crontab|psql)\b|>|\bsed\s+(-[a-zA-Z]*\s+)*-i/
function windowStatusPayload(run) {
  const match = String(run).match(/cat <<'WINDOW_STATUS'\n([\s\S]*?)\nWINDOW_STATUS\n/)
  assert.ok(match, 'the status step carries its remote payload as the quoted WINDOW_STATUS heredoc')
  return match[1]
}
function assertReadOnlyStatusPayload(payload) {
  const lines = payload.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  for (const line of lines) {
    // The one command substitution allowed is the read time.
    const plain = line.replace('$(date -u +%Y-%m-%dT%H:%M:%SZ)', 'DATE')
    assert.ok(STATUS_ALLOWED_LINE.some((pattern) => pattern.test(plain)), `status payload line is not a plain read: ${line}`)
    assert.doesNotMatch(plain.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""'), STATUS_FORBIDDEN, `status payload line may change the host: ${line}`)
    assert.ok(!plain.includes('$('), `no other command substitution: ${line}`)
  }
  for (const file of ['"${status_home}/state"', '"${status_run_dir}/rc"', '"${status_run_dir}/window.log"']) {
    assert.ok(lines.some((line) => line.startsWith('sed -n ') && line.endsWith(file)), `the payload reads ${file}`)
  }
  assert.equal(lines.at(-1), 'exit 0')
}

test('the deploy window status step is read-only: one pinned ssh session, reads only, no output', () => {
  const steps = workflow.jobs.deploy.steps
  const status = steps.find((entry) => entry.id === 'window_status')
  assert.ok(status, 'deploy has a window_status step')
  assert.equal(status.if, 'always()')
  assert.equal(status['continue-on-error'], true)
  assert.equal(typeof status['timeout-minutes'], 'number')
  assert.ok(status['timeout-minutes'] > 0 && status['timeout-minutes'] <= 10)
  const at = steps.indexOf(status)
  assert.ok(at > steps.findIndex((entry) => entry.id === 'remote_deploy'), 'after remote_deploy')
  assert.equal(steps[at + 1].name, 'Write deploy summary (preflight + runbooks)', 'directly before the summary step')
  assert.deepEqual(Object.keys(status.env).sort(), ['DEPLOY_HOST', 'DEPLOY_KNOWN_HOSTS', 'DEPLOY_SSH_KEY_B64', 'DEPLOY_USER'])
  const run = status.run
  assert.doesNotMatch(run, /\bdocker\b/, 'no docker anywhere in the step')
  assert.doesNotMatch(run, /GITHUB_OUTPUT|GITHUB_STEP_SUMMARY|deploy\.log/, 'no step output, no step summary, no write to deploy.log')
  assert.equal((run.match(/\bssh \$ssh_opts /g) ?? []).length, 1, 'exactly one ssh session')
  assert.match(run, /ssh_opts="-o StrictHostKeyChecking=yes -o UserKnownHostsFile=\$HOME\/\.ssh\/known_hosts -o GlobalKnownHostsFile=\/dev\/null /)
  assert.match(run, /\| ssh \$ssh_opts "\$DEPLOY_USER@\$DEPLOY_HOST" bash -s 2>&1 \| tee "\$status_log"\n/)
  const payload = windowStatusPayload(run)
  assertReadOnlyStatusPayload(payload)
  const syntax = spawnSync('bash', ['-n'], { input: `WINDOW_RUN=1-1\n${payload}\n`, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('the read-only check on the status payload is load-bearing (negative controls)', () => {
  const payload = windowStatusPayload(workflow.jobs.deploy.steps.find((entry) => entry.id === 'window_status').run)
  assertReadOnlyStatusPayload(payload)
  const injected = [
    'timeout 90 docker stop -t 60 metasheet-web',
    'docker compose -p metasheet2 up -d web',
    'touch "${status_home}/abort"',
    'rm -f "${status_home}/state"',
    'mv "${status_home}/state" "${status_home}/state.old"',
    'echo "phase=done-new" > "${status_home}/state"',
    'flock -n "${status_home}/lock" true',
    'sed -i -e s/needs-owner/done-new/ "${status_home}/state"',
    'echo "$(rm -rf "${status_home}")"',
    'kill -0 "$(cat "${status_run_dir}/window.pid")"',
    `sed -n -E 's#^(.*)$#\\1#w /tmp/status-copy' "\${status_home}/state"`,
    `sed -n -E 's#^(.*)$#\\1#pe' "\${status_home}/state"`,
  ]
  for (const line of injected) {
    assert.throws(() => assertReadOnlyStatusPayload(payload.replace('\nexit 0', `\n${line}\nexit 0`)), assert.AssertionError, line)
  }
})
