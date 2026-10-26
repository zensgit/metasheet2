import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(process.env.PLM_TEST_DEPLOY_SOURCE || path.join(here, 'multitable-onprem-deploy-easy.sh'))
const freshToken = 'fresh-session-token+exact/bytes='
const inheritedToken = 'inherited-session-must-not-replace-fresh-login'
const password = 'synthetic-private-password!'

function runDeploy({ manager, verify, body = JSON.stringify({ data: { token: freshToken } }),
  http = '200', curlExit = '0', inherited = '', healthExit = '0' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'plm-manager-handoff-'))
  try {
    const ops = path.join(root, 'scripts/ops')
    const bin = path.join(root, 'bin')
    mkdirSync(ops, { recursive: true })
    mkdirSync(bin)
    const write = (dir, name, text) => writeFileSync(path.join(dir, name), text, { mode: 0o700 })
    write(ops, 'multitable-onprem-deploy-easy.sh', source)
    write(ops, 'attendance-onprem-bootstrap.sh', '#!/bin/sh\nprintf %s "$SERVICE_MANAGER" > "$FIXTURE_ROOT/bootstrap-manager"\n')
    write(ops, 'attendance-onprem-bootstrap-admin.sh', '#!/bin/sh\nprintf %s "$VERIFY_LOGIN" > "$FIXTURE_ROOT/admin-verify"\n')
    write(ops, 'multitable-onprem-healthcheck.sh', `#!/bin/sh
set -eu
printf %s "$SERVICE_MANAGER" > "$FIXTURE_ROOT/health-manager"
printf %s "$AUTH_TOKEN" > "$FIXTURE_ROOT/health-token"
printf '%s\\n' "$BASE_URL" "$API_BASE" "$CHECK_NGINX" "$EXPECT_PRODUCT_MODE" > "$FIXTURE_ROOT/health-args"
case "$SERVICE_MANAGER" in
  none) ;;
  pm2) pm2 describe metasheet-backend ;;
  systemd) systemctl is-active --quiet metasheet-backend.service ;;
  auto) pm2 describe metasheet-backend ;;
  *) exit 98 ;;
esac
exit "$HEALTH_EXIT"
`)
    // No curl or supervisor can escape to the host: these deterministic executables are first in PATH.
    write(bin, 'curl', `#!/bin/sh
set -eu
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w|-X|-H|--data|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */health) printf 200 ;;
  */auth/login)
    printf '%s' "$LOGIN_BODY" > "$output"
    printf '%s' "$LOGIN_HTTP"
    exit "$LOGIN_CURL_EXIT" ;;
  *) exit 97 ;;
esac
`)
    for (const managerName of ['pm2', 'systemctl']) {
      write(bin, managerName, `#!/bin/sh\nprintf '%s\\n' '${managerName}' >> "$FIXTURE_ROOT/managers"\n`)
    }
    for (const name of ['apps/web/dist/index.html', 'packages/core-backend/dist/src/db/migrate.js', 'env']) {
      const file = path.join(root, name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, 'owned fixture')
    }
    const env = { ...process.env, PATH: bin + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin',
      FIXTURE_ROOT: root, TMPDIR: root, ENV_FILE: path.join(root, 'env'), API_BASE: 'http://127.0.0.1:9/api',
      ADMIN_EMAIL: 'owned@example.invalid', ADMIN_PASSWORD: password, AUTH_TOKEN: inherited,
      BUILD_WEB: '0', BUILD_BACKEND: '0', CHECK_NGINX: '0', EXPECT_PRODUCT_MODE: 'plm-workbench',
      LOGIN_BODY: body, LOGIN_HTTP: http, LOGIN_CURL_EXIT: curlExit, HEALTH_EXIT: healthExit }
    delete env.SERVICE_MANAGER
    delete env.VERIFY_LOGIN
    if (manager !== undefined) env.SERVICE_MANAGER = manager
    if (verify !== undefined) env.VERIFY_LOGIN = verify
    const result = spawnSync('/bin/bash', [path.join(ops, 'multitable-onprem-deploy-easy.sh')], {
      env, encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    const read = name => existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), 'utf8') : null
    const output = result.stdout + result.stderr
    for (const secret of [password, freshToken, inheritedToken]) {
      assert.equal(output.includes(secret), false, 'Operator output must not include credentials')
    }
    return { code: result.status, output, manager: read('health-manager'), token: read('health-token'),
      bootstrapManager: read('bootstrap-manager'), adminVerify: read('admin-verify'),
      args: read('health-args'), managers: read('managers') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function assertHealth(result, manager, token) {
  assert.equal(result.manager, manager)
  assert.equal(result.bootstrapManager, manager)
  assert.equal(result.token, token, 'Health receives the exact selected session bytes')
  assert.equal(result.args, 'http://127.0.0.1:9\nhttp://127.0.0.1:9/api\n0\nplm-workbench\n')
  assert.equal(result.managers, manager === 'none' ? null : manager === 'systemd' ? 'systemctl\n' : 'pm2\n')
}

for (const manager of [undefined, 'none', 'pm2', 'systemd', 'auto']) {
  test(`default login requires fresh token and preserves caller manager: ${manager ?? 'default pm2'}`, () => {
    const result = runDeploy({ manager, inherited: inheritedToken })
    assert.equal(result.code, 0)
    assert.equal(result.adminVerify, '1')
    assertHealth(result, manager ?? 'pm2', freshToken)
  })

  for (const token of [freshToken, '']) {
    test(`explicit VERIFY_LOGIN=0 retains limited health branch and manager: ${manager ?? 'default pm2'} / ${token ? 'token' : 'no token'}`, () => {
      const result = runDeploy({ manager, verify: '0', body: JSON.stringify({ token }) })
      assert.equal(result.code, 0)
      assert.equal(result.adminVerify, '0')
      assertHealth(result, manager ?? 'pm2', token)
    })
  }
}

test('explicit VERIFY_LOGIN=1 accepts a fresh top-level token unchanged', () => {
  const result = runDeploy({ manager: 'none', verify: '1', body: JSON.stringify({ token: freshToken }) })
  assert.equal(result.code, 0)
  assertHealth(result, 'none', freshToken)
})

test('nonblank string token bytes are forwarded without normalization or JWT format assumptions', () => {
  const token = '  fresh session bytes  '
  const result = runDeploy({ manager: 'none', body: JSON.stringify({ token }) })
  assert.equal(result.code, 0)
  assertHealth(result, 'none', token)
})

const failures = {
  missing: { body: '{}' },
  empty: { body: '{"data":{"token":""}}' },
  malformed: { body: '{not valid JSON' },
  'numeric token': { body: '{"token":7}' },
  'object token': { body: '{"token":{}}' },
  'array token': { body: '{"token":["invalid"]}' },
  'boolean token': { body: '{"token":true}' },
  'blank token': { body: JSON.stringify({ token: ' \t ' }) },
  'HTTP failure': { http: '401' },
  'curl failure': { curlExit: '7' },
}
for (const verify of [undefined, '1']) {
  for (const inherited of ['', inheritedToken]) {
    for (const [name, response] of Object.entries(failures)) {
      test(`required fresh login refuses ${name} before health: verify=${verify ?? 'default'}, inherited=${Boolean(inherited)}`, () => {
        const result = runDeploy({ manager: 'none', verify, inherited, ...response })
        assert.notEqual(result.code, 0)
        assert.equal(result.manager, null, 'No health invocation is allowed without a fresh required token')
        assert.equal(result.token, null)
        assert.equal(result.managers, null)
      })
    }
  }
}

test('explicit limited mode preserves the existing inherited-token fallback', () => {
  const result = runDeploy({ manager: 'none', verify: '0', body: '{}', inherited: inheritedToken })
  assert.equal(result.code, 0)
  assertHealth(result, 'none', inheritedToken)
})

for (const token of [freshToken, '']) {
  test(`health failure propagates exact exit status: ${token ? 'fresh required login' : 'limited no token'}`, () => {
    const result = runDeploy({ manager: 'none', verify: token ? '1' : '0',
      body: JSON.stringify({ token }), healthExit: '23' })
    assert.equal(result.code, 23)
    assertHealth(result, 'none', token)
  })
}


const upgradeSource = readFileSync(process.env.PLM_TEST_UPGRADE_SOURCE || path.join(here, 'attendance-onprem-package-upgrade.sh'))

function runUpgrade({ manager, health = '1', updateExit = '0', healthExit = '0' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'plm-upgrade-manager-'))
  try {
    const ops = path.join(root, 'scripts/ops')
    const bin = path.join(root, 'bin')
    mkdirSync(ops, { recursive: true })
    mkdirSync(bin)
    const write = (dir, name, text) => writeFileSync(path.join(dir, name), text, { mode: 0o700 })
    write(ops, 'attendance-onprem-package-upgrade.sh', upgradeSource)
    for (const [step, exitVariable] of [['update', 'UPDATE_EXIT'], ['healthcheck', 'HEALTH_EXIT']]) {
      write(ops, `attendance-onprem-${step}.sh`, `#!/bin/sh
set -eu
printf '%s\\n' "$SERVICE_MANAGER" > "$FIXTURE_ROOT/${step}-manager"
exit "$${exitVariable}"
`)
    }
    // Only metadata lookup and explicitly owned child-script dispatch are available in PATH.
    write(bin, 'dirname', '#!/bin/sh\nprintf %s "${1%/*}"\n')
    write(bin, 'env', `#!/bin/sh
set -eu
last=''
for arg in "$@"; do last="$arg"; done
case "$last" in
  "$FIXTURE_ROOT/scripts/ops/attendance-onprem-update.sh"|"$FIXTURE_ROOT/scripts/ops/attendance-onprem-healthcheck.sh") exec /usr/bin/env "$@" ;;
  *) exit 97 ;;
esac
`)
    writeFileSync(path.join(root, 'env'), 'owned fixture')
    const env = { PATH: bin, FIXTURE_ROOT: root, TMPDIR: root, ENV_FILE: path.join(root, 'env'),
      RUN_MIGRATIONS: '0', RESTART_SERVICE: '0', RELOAD_NGINX: '0', INSTALL_DEPS: '0',
      RUN_HEALTHCHECK: health, UPDATE_EXIT: updateExit, HEALTH_EXIT: healthExit }
    if (manager !== undefined) env.SERVICE_MANAGER = manager
    const result = spawnSync('/bin/bash', [path.join(ops, 'attendance-onprem-package-upgrade.sh')], {
      env, encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    const read = step => existsSync(path.join(root, `${step}-manager`)) ? readFileSync(path.join(root, `${step}-manager`), 'utf8') : null
    return { code: result.status, update: read('update'), health: read('healthcheck') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const manager of [undefined, 'none', 'pm2', 'systemd']) {
  test(`package upgrade manager handoff preserves caller: ${manager ?? 'default pm2'}`, () => {
    const result = runUpgrade({ manager })
    assert.deepEqual(result, { code: 0, update: `${manager ?? 'pm2'}\n`, health: `${manager ?? 'pm2'}\n` })
  })
}

test('package upgrade manager handoff skips disabled health', () => {
  assert.deepEqual(runUpgrade({ manager: 'none', health: '0' }), { code: 0, update: 'none\n', health: null })
})

test('package upgrade manager handoff stops after exact update failure', () => {
  assert.deepEqual(runUpgrade({ manager: 'none', updateExit: '31' }), { code: 31, update: 'none\n', health: null })
})

test('package upgrade manager handoff propagates exact health failure', () => {
  assert.deepEqual(runUpgrade({ manager: 'none', healthExit: '23' }), { code: 23, update: 'none\n', health: 'none\n' })
})
