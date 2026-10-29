import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLOBAL_HISTORY_FLAG_BY_KEY, isActivated } from './global-history-flag-manifest.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(here, '..', '..')

const realScripts = [
  'scripts/ops/attendance-onprem-package-upgrade.sh',
  'scripts/ops/attendance-onprem-update.sh',
  'scripts/ops/attendance-onprem-bootstrap.sh',
  'scripts/ops/multitable-onprem-deploy-easy.sh',
  'scripts/ops/attendance-onprem-healthcheck.sh',
  'scripts/ops/multitable-onprem-healthcheck.sh',
  'scripts/ops/attendance-onprem-env-check.sh',
]

const jwtSecret = 'synthetic-jwt-not-a-secret-32ch-min'
const dbPassword = 'synthetic-db-password'
const databaseUrl = 'postgresql://owned.invalid/synthetic'
const encryptionKey = 'synthetic-encryption-key-literal'
const encryptionSalt = 'synthetic-encryption-salt-literal'
const adminPassword = 'synthetic-admin-password'
const freshToken = 'synthetic-fresh-token'
const inheritedToken = 'synthetic-inherited-token'
const customApp = 'owned-file-app'
const customUnit = 'owned-file.service'
const defaultApp = 'metasheet-backend'
const defaultUnit = 'metasheet-backend.service'

const secretFields = [
  ['JWT_SECRET', jwtSecret],
  ['POSTGRES_PASSWORD', dbPassword],
  ['DATABASE_URL', databaseUrl],
  ['ENCRYPTION_KEY', encryptionKey],
  ['ENCRYPTION_SALT', encryptionSalt],
  ['ADMIN_PASSWORD', adminPassword],
  ['fresh token', freshToken],
  ['inherited token', inheritedToken],
]

function assertNoSecrets(output) {
  for (const [name, value] of secretFields) {
    assert.equal(output.includes(value), false, `operator output contains ${name}`)
  }
}

function framingTrapLine(kind) {
  const write = {
    truncated: `builtin printf "pm2\\000${customApp}\\000${defaultUnit}" > "$receipt"`,
    extraNul: `builtin printf "pm2\\000${customApp}\\000${defaultUnit}\\000extra\\000" > "$receipt"`,
    trailingNonNul: `builtin printf "pm2\\000${customApp}\\000${defaultUnit}\\000x" > "$receipt"`,
    missing: 'rm -f "$receipt"',
  }[kind]
  if (!write) throw new Error(`unknown framing trap: ${kind}`)
  return [
    "builtin trap '",
    'status=$?',
    'receipt=${MS_EFFECTIVE_SERVICE_RECEIPT-}',
    'tmp=${TMPDIR-}',
    'if [[ -n "$tmp" && -n "$receipt" && -s "$receipt" ]]; then',
    '  case "$receipt" in',
    '    "$tmp"/mktemp-[0-9]|"$tmp"/mktemp-[0-9][0-9]|"$tmp"/mktemp-[0-9][0-9][0-9])',
    `      ${write}`,
    '      ;;',
    '  esac',
    'fi',
    'exit "$status"',
    "' EXIT",
  ].join('\n')
}

function validEnvLines(root, { productMode, assignments = [], decoy = false, framing = '' }) {
  const lines = [
    `JWT_SECRET=${jwtSecret}`,
    `POSTGRES_PASSWORD=${dbPassword}`,
    `DATABASE_URL=${databaseUrl}`,
    `PRODUCT_MODE=${productMode}`,
    'ATTENDANCE_IMPORT_REQUIRE_TOKEN=1',
    `ATTENDANCE_IMPORT_UPLOAD_DIR=${path.join(root, 'upload')}`,
    'ATTENDANCE_IMPORT_CSV_MAX_ROWS=1000',
    'DEPLOYMENT_MODEL=onprem',
    'BCRYPT_SALT_ROUNDS=12',
    `ENCRYPTION_KEY=${encryptionKey}`,
    `ENCRYPTION_SALT=${encryptionSalt}`,
    ...assignments,
  ]
  if (decoy) lines.push(`MS_EFFECTIVE_SERVICE_RECEIPT=${path.join(root, 'decoy-receipt')}`)
  lines.push('builtin printf %s 1 >>"$MS_SOURCE_COUNT_FILE"')
  if (framing) lines.push(framingTrapLine(framing))
  return `${lines.join('\n')}\n`
}

function baseEnv(root) {
  return {
    PATH: path.join(root, 'bin'),
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    LANG: 'C',
    LC_ALL: 'C',
    FIXTURE_ROOT: root,
    MS_SOURCE_COUNT_FILE: path.join(root, 'source-count'),
    ENV_FILE: path.join(root, 'app.env'),
    CHECK_METRICS: '0',
  }
}

function writeExec(file, text) {
  writeFileSync(file, text, { mode: 0o700 })
}

function installTree(root) {
  mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(root, 'home'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(root, 'tmp'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(root, 'upload'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(root, 'scripts/ops'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(root, 'apps/web/dist'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(root, 'packages/core-backend/dist/src/db'), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(root, 'apps/web/dist/index.html'), 'owned fixture\n', { mode: 0o600 })
  writeFileSync(path.join(root, 'packages/core-backend/dist/src/db/migrate.js'), 'owned fixture\n', { mode: 0o600 })
  for (const rel of realScripts) {
    writeExec(path.join(root, rel), readFileSync(path.join(sourceRoot, rel)))
  }
  writeExec(path.join(root, 'scripts/ops/attendance-onprem-publish-web-dist.sh'), stubBodies.publish)
  writeExec(path.join(root, 'scripts/ops/attendance-onprem-bootstrap-admin.sh'), stubBodies.admin)
  for (const [name, body] of Object.entries(stubBodies)) {
    if (name === 'publish' || name === 'admin') continue
    writeExec(path.join(root, 'bin', name), body)
  }
}

function runBash(root, rel, env) {
  return spawnSync('/bin/bash', [path.join(root, rel)], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 8000,
  })
}

function finish(root, result) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assertNoSecrets(output)
  const trace = existsSync(path.join(root, 'trace')) ? readFileSync(path.join(root, 'trace'), 'utf8') : ''
  const countPath = path.join(root, 'source-count')
  const sourceCount = existsSync(countPath) ? readFileSync(countPath).length : 0
  return {
    code: result.status,
    output,
    trace,
    rows: parseTrace(trace),
    sourceCount,
  }
}

function parseTrace(text) {
  return text.split('\n').filter(Boolean).map(line => {
    const [cmd, action, target] = line.split('\t')
    return { cmd, action, target: target ?? '' }
  })
}

function isNginx(target) {
  return target === 'nginx' || target === 'nginx.service'
}

function actionIdentity(rows, output) {
  const acts = rows.filter(row =>
    (row.cmd === 'pm2' && (row.action === 'restart' || row.action === 'start')) ||
    (row.cmd === 'systemctl' && (row.action === 'restart' || row.action === 'start') && !isNginx(row.target)))
  if (acts.length === 0) {
    if (/SERVICE_MANAGER=none; skipping service (restart|start)/.test(output)) return { manager: 'none', target: '' }
    return { manager: '', target: '' }
  }
  assert.equal(acts.length, 1, 'one backend start or restart')
  const act = acts[0]
  return { manager: act.cmd === 'pm2' ? 'pm2' : 'systemd', target: act.target }
}

function healthIdentity(rows, output) {
  if (output.includes('Skipping process-manager check (SERVICE_MANAGER=none)')) return { manager: 'none', target: '' }
  const acts = rows.filter(row =>
    (row.cmd === 'pm2' && (row.action === 'restart' || row.action === 'start')) ||
    (row.cmd === 'systemctl' && (row.action === 'restart' || row.action === 'start') && !isNginx(row.target)))
  const last = acts.length === 0 ? -1 : rows.lastIndexOf(acts[acts.length - 1])
  const probes = rows.filter((row, index) => index > last && (
    (row.cmd === 'pm2' && (row.action === 'describe' || row.action === 'pid')) ||
    (row.cmd === 'systemctl' && (row.action === 'is-active' || row.action === 'list-unit-files') && !isNginx(row.target))))
  assert.equal(probes.length > 0, true, 'a health backend probe ran')
  const { cmd, target } = probes[0]
  assert.equal(probes.every(row => row.cmd === cmd && row.target === target), true, 'one health backend probe target')
  return { manager: cmd === 'pm2' ? 'pm2' : 'systemd', target }
}

function assertProtocolPresent() {
  const update = readFileSync(path.join(sourceRoot, 'scripts/ops/attendance-onprem-update.sh'), 'utf8')
  const bootstrap = readFileSync(path.join(sourceRoot, 'scripts/ops/attendance-onprem-bootstrap.sh'), 'utf8')
  const health = readFileSync(path.join(sourceRoot, 'scripts/ops/attendance-onprem-healthcheck.sh'), 'utf8')
  assert.equal(update.includes('MS_EFFECTIVE_SERVICE_RECEIPT'), true, 'update receipt protocol absent')
  assert.equal(bootstrap.includes('MS_EFFECTIVE_SERVICE_RECEIPT'), true, 'bootstrap receipt protocol absent')
  assert.equal(health.includes('MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY'), true, 'health raw mode absent')
}

function assertExact3Nul(bytes, fields) {
  const parts = []
  let start = 0
  let nuls = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) continue
    parts.push(bytes.subarray(start, i).toString('utf8'))
    start = i + 1
    nuls += 1
  }
  assert.equal(nuls, 3, 'receipt rejects a fourth NUL and requires exactly three NUL terminators')
  assert.equal(start, bytes.length, 'receipt rejects non-NUL trailing bytes after the third NUL')
  assert.deepEqual(parts, fields)
}

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'plm-effective-service-'))
  try {
    installTree(root)
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runUpgrade(extra, { envText }) {
  return withRoot(root => {
    writeFileSync(path.join(root, 'app.env'), envText(root), { mode: 0o600 })
    const result = runBash(root, 'scripts/ops/attendance-onprem-package-upgrade.sh', { ...baseEnv(root), ...extra })
    return finish(root, result)
  })
}

function runDeploy(extra, { envText }) {
  return withRoot(root => {
    writeFileSync(path.join(root, 'app.env'), envText(root), { mode: 0o600 })
    const result = runBash(root, 'scripts/ops/multitable-onprem-deploy-easy.sh', {
      ...baseEnv(root),
      API_BASE: 'http://127.0.0.1:9/api',
      ADMIN_EMAIL: 'owned@example.invalid',
      ADMIN_PASSWORD: adminPassword,
      ADMIN_NAME: 'Owned Admin',
      ...extra,
    })
    return finish(root, result)
  })
}

function runDirect(rel, extra, { envText } = {}) {
  return withRoot(root => {
    if (envText) writeFileSync(path.join(root, 'app.env'), envText(root), { mode: 0o600 })
    const result = runBash(root, rel, { ...baseEnv(root), CHECK_NGINX: '0', ...extra })
    return finish(root, result)
  })
}

const stubBodies = {
  bash: `#!/bin/bash
set -eu
exec /bin/bash "$@"
`,
  env: `#!/bin/bash
set -eu
while [[ $# -gt 0 ]]; do
  case "$1" in
    *=*)
      key="\${1%%=*}"
      case "$key" in
        PATH|HOME|TMPDIR|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH) exit 97 ;;
      esac
      export "$1"
      shift
      ;;
    *) break ;;
  esac
done
[[ $# -ge 1 ]] || exit 97
cmd="$1"
[[ "$cmd" == "$FIXTURE_ROOT"/scripts/ops/*.sh ]] || exit 97
exec /bin/bash "$@"
`,
  dirname: `#!/bin/bash
set -eu
[[ $# -eq 1 && "$1" != -* ]] || exit 97
exec /usr/bin/dirname "$1"
`,
  grep: `#!/bin/bash
set -eu
[[ "$1" == -E && $# -eq 3 ]] || exit 97
[[ "$3" == "$FIXTURE_ROOT"/* ]] || exit 97
exec /usr/bin/grep -E "$2" "$3"
`,
  tail: `#!/bin/bash
set -eu
[[ "$1" == -n && "$2" == 1 ]] || exit 97
if [[ $# -eq 2 ]]; then exec /usr/bin/tail -n 1; fi
[[ $# -eq 3 && "$3" == "$FIXTURE_ROOT"/* ]] || exit 97
exec /usr/bin/tail -n 1 "$3"
`,
  tr: `#!/bin/bash
set -eu
[[ "$1" == -d && "$2" == '[:space:]' && $# -eq 2 ]] || exit 97
exec /usr/bin/tr -d '[:space:]'
`,
  cat: `#!/bin/bash
set -eu
[[ $# -eq 1 && "$1" == "$FIXTURE_ROOT"/* ]] || exit 97
exec /bin/cat -- "$1"
`,
  pm2: `#!/bin/bash
set -eu
action="\${1:-}"
shift || true
target=""
case "$action" in
  describe|pid|restart) target="\${1:-}" ;;
  start)
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --only ]]; then target="$2"; shift 2; else shift; fi
    done
    ;;
  save) ;;
  *) exit 97 ;;
esac
printf 'pm2\\t%s\\t%s\\n' "$action" "$target" >> "$FIXTURE_ROOT/trace"
if [[ "$action" == pid ]]; then printf '4242\\n'; fi
exit 0
`,
  systemctl: `#!/bin/bash
set -eu
action="\${1:-}"
shift || true
target=""
case "$action" in
  daemon-reload) ;;
  is-active) [[ "\${1:-}" == --quiet ]] || exit 97; target="\${2:-}" ;;
  restart|start|reload) target="\${1:-}" ;;
  list-unit-files) target="\${1:-}" ;;
  *) exit 97 ;;
esac
printf 'systemctl\\t%s\\t%s\\n' "$action" "$target" >> "$FIXTURE_ROOT/trace"
exit 0
`,
  pnpm: `#!/bin/bash
set -eu
[[ "$1" == install && "$2" == --frozen-lockfile && $# -eq 2 ]] || exit 97
printf 'pnpm\\tinstall\\t\\n' >> "$FIXTURE_ROOT/trace"
exit 0
`,
  git: `#!/bin/bash
set -eu
printf 'git\\tunexpected\\t\\n' >> "$FIXTURE_ROOT/trace"
exit 97
`,
  sleep: `#!/bin/bash
set -eu
printf 'sleep\\tunexpected\\t\\n' >> "$FIXTURE_ROOT/trace"
exit 97
`,
  node: `#!/bin/bash
set -eu
if [[ "\${1:-}" != -e ]]; then
  case "\${1:-}" in
    */packages/core-backend/dist/src/db/migrate.js)
      printf 'node\\tmigrate\\t\\n' >> "$FIXTURE_ROOT/trace"
      exit "\${MS_FIXTURE_MIGRATE_STATUS:-0}"
      ;;
  esac
  exit 97
fi
script="$2"
payload="\${3:-}"
login='process.stdout.write(typeof token === "string" && token.trim() ? token : "");'
checks='process.stdout.write(JSON.stringify({ mode, plm }));'
mode='process.stdout.write(String(parsed.mode || ""));'
if [[ "$script" == *"$login"* && "$payload" == '{"data":{"token":"synthetic-fresh-token"}}' ]]; then
  printf 'node\\tlogin\\t\\n' >> "$FIXTURE_ROOT/trace"
  printf %s 'synthetic-fresh-token'
  exit 0
fi
if [[ "$script" == *"$checks"* && "$payload" == '{"data":{"features":{"mode":"platform","plm":false}}}' ]]; then
  printf 'node\\tchecks\\t\\n' >> "$FIXTURE_ROOT/trace"
  printf %s '{"mode":"platform","plm":false}'
  exit 0
fi
if [[ "$script" == *"$mode"* && "$payload" == '{"mode":"platform","plm":false}' ]]; then
  printf 'node\\tmode\\t\\n' >> "$FIXTURE_ROOT/trace"
  printf %s platform
  exit 0
fi
exit 97
`,
  curl: `#!/bin/bash
set -eu
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w|-X|-H|--data|--connect-timeout|--max-time) shift 2 ;;
    -fsS|-sS) shift ;;
    -*) exit 97 ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  http://127.0.0.1:8900/health|http://127.0.0.1/|http://127.0.0.1/api/plugins|http://127.0.0.1:9/|http://127.0.0.1:9/api/plugins|http://127.0.0.1:9/api/health|http://127.0.0.1:9/api/auth/login|http://127.0.0.1:9/api/auth/me) ;;
  *) exit 97 ;;
esac
class=check
[[ "$url" == */auth/login ]] && class=login
[[ "$url" == */auth/me ]] && class=me
[[ "$url" == */api/health ]] && class=ready
printf 'curl\\t%s\\t%s\\n' "$class" "$url" >> "$FIXTURE_ROOT/trace"
if [[ "$class" == login ]]; then
  [[ -n "$output" && ( "$output" == /dev/null || "$output" == "$FIXTURE_ROOT"/* ) ]] || exit 97
  if [[ "\${MS_FIXTURE_LOGIN_HTTP:-200}" == 200 ]]; then
    [[ "$output" == "$FIXTURE_ROOT"/* ]] || exit 97
    printf %s '{"data":{"token":"synthetic-fresh-token"}}' > "$output"
    printf 200
  else
    [[ "$output" == /dev/null || "$output" == "$FIXTURE_ROOT"/* ]] || exit 97
    [[ "$output" == /dev/null ]] || printf %s '{}' > "$output"
    printf 401
  fi
  exit 0
fi
if [[ "$class" == ready ]]; then printf 200; exit 0; fi
if [[ "$class" == me ]]; then printf %s '{"data":{"features":{"mode":"platform","plm":false}}}'; exit 0; fi
if [[ "\${MS_FIXTURE_HEALTH_CURL_FAIL:-0}" == 1 ]]; then
  : > "$FIXTURE_ROOT/health-curl-seen"
  exit 22
fi
exit 0
`,
  mkdir: `#!/bin/bash
set -eu
[[ "\${1:-}" == -p ]] || exit 97
[[ $# -eq 2 && "$2" == "$FIXTURE_ROOT"/* ]] || exit 97
/bin/mkdir -p -- "$2"
printf 'mkdir\\tok\\t%s\\n' "$2" >> "$FIXTURE_ROOT/trace"
`,
  mktemp: `#!/bin/bash
set -eu
[[ $# -eq 0 ]] || exit 97
n=0
[[ -f "$FIXTURE_ROOT/mktemp-seq" ]] && n=$(<"$FIXTURE_ROOT/mktemp-seq")
n=$((n + 1))
printf %s "$n" > "$FIXTURE_ROOT/mktemp-seq"
target="$FIXTURE_ROOT/tmp/mktemp-$n"
: > "$target"
printf '%s\\n' "$target"
printf 'mktemp\\tcreate\\t%s\\n' "$target" >> "$FIXTURE_ROOT/trace"
`,
  rm: `#!/bin/bash
set -eu
[[ "\${1:-}" == -f && $# -eq 2 ]] || exit 97
[[ "$2" == "$FIXTURE_ROOT"/* ]] || exit 97
if [[ "\${MS_FIXTURE_FAIL_RM_AFTER_HEALTH:-0}" == 1 && -f "$FIXTURE_ROOT/health-curl-seen" ]]; then
  printf 'rm\\tfail\\t%s\\n' "$2" >> "$FIXTURE_ROOT/trace"
  exit 31
fi
if [[ -f "$FIXTURE_ROOT/requested-receipt" && "$2" == "$(<"$FIXTURE_ROOT/requested-receipt")" && -f "$2" ]]; then
  /bin/cat -- "$2" > "$FIXTURE_ROOT/receipt-before-cleanup"
fi
/bin/rm -f -- "$2"
printf 'rm\\tok\\t%s\\n' "$2" >> "$FIXTURE_ROOT/trace"
`,
  publish: `#!/bin/bash
set -eu
printf 'phase\\tpublish\\t\\n' >> "$FIXTURE_ROOT/trace"
exit 0
`,
  admin: `#!/bin/bash
set -eu
printf 'phase\\tadmin\\t\\n' >> "$FIXTURE_ROOT/trace"
exit 0
`,
}

test('effective service RED upgrade none to file pm2 custom name', () => {
  const observed = runUpgrade({
    SERVICE_MANAGER: 'none',
    INSTALL_DEPS: '1',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '1',
    RELOAD_NGINX: '1',
    RUN_HEALTHCHECK: '1',
    CHECK_NGINX: '1',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance', assignments: [`SERVICE_MANAGER=pm2`, `PM2_APP_NAME=${customApp}`] }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.sourceCount, 1)
  assert.equal(observed.output.includes('Env check OK (REQUIRE_ATTENDANCE_ONLY=1)'), true)
  assert.equal(observed.rows.some(row => row.cmd === 'phase' && row.action === 'publish'), true)
  assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'pm2', target: customApp })
  assert.deepEqual(actionIdentity(observed.rows, observed.output), healthIdentity(observed.rows, observed.output))
})

test('effective service RED deploy pm2 to file systemd custom unit', () => {
  const observed = runDeploy({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    START_SERVICE: '1',
    CHECK_NGINX: '0',
  }, {
    envText: root => validEnvLines(root, { productMode: 'platform', assignments: [`SERVICE_MANAGER=systemd`, `SYSTEMD_SERVICE_NAME=${customUnit}`] }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.sourceCount, 1)
  assert.equal(observed.output.includes('Env check OK (REQUIRE_ATTENDANCE_ONLY=0)'), true)
  const publish = observed.rows.findIndex(row => row.cmd === 'phase' && row.action === 'publish')
  const admin = observed.rows.findIndex(row => row.cmd === 'phase' && row.action === 'admin')
  const probe = observed.rows.findIndex((row, index) => index > admin && (
    (row.cmd === 'pm2' && row.action === 'describe') ||
    (row.cmd === 'systemctl' && row.action === 'is-active' && !isNginx(row.target))))
  assert.equal(publish >= 0 && admin > publish && probe > admin, true)
  assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'systemd', target: customUnit })
  assert.deepEqual(actionIdentity(observed.rows, observed.output), healthIdentity(observed.rows, observed.output))
})

test('effective service envgate valid file zero source', () => {
  const observed = runDirect('scripts/ops/attendance-onprem-env-check.sh', { REQUIRE_ATTENDANCE_ONLY: '1' }, {
    envText: root => validEnvLines(root, { productMode: 'attendance', assignments: [`SERVICE_MANAGER=pm2`, `PM2_APP_NAME=${customApp}`] }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.sourceCount, 0)
  assert.equal(observed.output.includes('Env check OK (REQUIRE_ATTENDANCE_ONLY=1)'), true)
})

test('effective service envgate missing jwt zero source', () => {
  const observed = runDirect('scripts/ops/attendance-onprem-env-check.sh', { REQUIRE_ATTENDANCE_ONLY: '1' }, {
    envText: () => 'SERVICE_MANAGER=pm2\nbuiltin printf %s 1 >>"$MS_SOURCE_COUNT_FILE"\n',
  })
  assert.notEqual(observed.code, 0)
  assert.equal(observed.sourceCount, 0)
  assert.equal(observed.output.includes('JWT_SECRET is missing'), true)
})

test('effective service preserve unchanged defaults stay equal', () => {
  const observed = runUpgrade({
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '1',
    RELOAD_NGINX: '0',
    RUN_HEALTHCHECK: '1',
    CHECK_NGINX: '0',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance' }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.sourceCount, 1)
  assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'pm2', target: defaultApp })
  assert.deepEqual(actionIdentity(observed.rows, observed.output), healthIdentity(observed.rows, observed.output))
})

test('effective service preserve direct empty name normalizes to default app', () => {
  const observed = runDirect('scripts/ops/attendance-onprem-healthcheck.sh', {
    SERVICE_MANAGER: 'pm2',
    PM2_APP_NAME: '',
    BASE_URL: 'http://127.0.0.1:9',
    API_BASE: 'http://127.0.0.1:9/api',
  })
  assert.equal(observed.code, 0)
  assert.deepEqual(healthIdentity(observed.rows, observed.output), { manager: 'pm2', target: defaultApp })
})

test('effective service preserve direct unset manager stays auto', () => {
  const observed = runDirect('scripts/ops/attendance-onprem-healthcheck.sh', {
    BASE_URL: 'http://127.0.0.1:9',
    API_BASE: 'http://127.0.0.1:9/api',
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.output.includes('SERVICE_MANAGER=auto') || observed.rows.some(row => row.cmd === 'pm2' && row.action === 'describe' && row.target === defaultApp), true)
  assert.deepEqual(healthIdentity(observed.rows, observed.output), { manager: 'pm2', target: defaultApp })
})

test('effective service preserve upgrade migration failure skips health', () => {
  const observed = runUpgrade({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '1',
    RELOAD_NGINX: '0',
    RUN_HEALTHCHECK: '1',
    CHECK_NGINX: '0',
    MS_FIXTURE_MIGRATE_STATUS: '31',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance' }),
  })
  assert.equal(observed.code, 31)
  assert.equal(observed.sourceCount, 1)
  assert.equal(observed.rows.some(row => row.cmd === 'phase' && row.action === 'publish'), false)
  assert.equal(observed.rows.some(row => row.cmd === 'curl'), false)
  assert.equal(observed.rows.some(row => row.cmd === 'pm2' && (row.action === 'restart' || row.action === 'start')), false)
})

test('effective service carrier upgrade same manager different pm2 name', () => {
  assertProtocolPresent()
  const observed = runUpgrade({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '1',
    RELOAD_NGINX: '0',
    RUN_HEALTHCHECK: '1',
    CHECK_NGINX: '0',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance', assignments: [`PM2_APP_NAME=${customApp}`] }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.sourceCount, 1)
  assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'pm2', target: customApp })
  assert.deepEqual(healthIdentity(observed.rows, observed.output), { manager: 'pm2', target: customApp })
})

test('effective service carrier upgrade file none', () => {
  assertProtocolPresent()
  const observed = runUpgrade({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '1',
    RELOAD_NGINX: '0',
    RUN_HEALTHCHECK: '1',
    CHECK_NGINX: '0',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance', assignments: ['SERVICE_MANAGER=none'] }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.sourceCount, 1)
  assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'none', target: '' })
  assert.deepEqual(healthIdentity(observed.rows, observed.output), { manager: 'none', target: '' })
  assert.equal(observed.rows.some(row => row.cmd === 'pm2'), false)
  assert.equal(observed.rows.some(row => row.cmd === 'curl' && row.action === 'check'), true)
})

test('effective service carrier action off empty manager refuses ambiguous health', () => {
  assertProtocolPresent()
  const observed = runUpgrade({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '0',
    RELOAD_NGINX: '0',
    RUN_HEALTHCHECK: '1',
    CHECK_NGINX: '0',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance', assignments: ['SERVICE_MANAGER='] }),
  })
  assert.notEqual(observed.code, 0)
  assert.equal(observed.sourceCount, 1)
  assert.equal(observed.rows.some(row => row.cmd === 'pm2' && row.target === defaultApp), false)
  assert.equal(observed.rows.some(row => row.cmd === 'curl'), false)
})

test('effective service carrier upgrade health off emits no receipt', () => {
  assertProtocolPresent()
  const observed = runUpgrade({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '1',
    RELOAD_NGINX: '0',
    RUN_HEALTHCHECK: '0',
    CHECK_NGINX: '0',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance', assignments: [`PM2_APP_NAME=${customApp}`] }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.sourceCount, 1)
  assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'pm2', target: customApp })
  assert.equal(observed.rows.some(row => row.cmd === 'curl'), false)
  assert.equal(observed.rows.some(row => row.cmd === 'mktemp'), false)
})

test('effective service carrier upgrade health off clears ambient receipt sentinel', () => {
  assertProtocolPresent()
  const upgrade = readFileSync(path.join(sourceRoot, 'scripts/ops/attendance-onprem-package-upgrade.sh'), 'utf8')
  assert.equal(upgrade.includes('MS_EFFECTIVE_SERVICE_RECEIPT'), true, 'upgrade receipt option absent')
  const root = mkdtempSync(path.join(tmpdir(), 'plm-effective-service-'))
  const poison = path.join(root, 'ambient-receipt-sentinel')
  const sentinel = Buffer.from('ambient-owned-receipt-sentinel\n', 'utf8')
  try {
    installTree(root)
    writeFileSync(path.join(root, 'app.env'), validEnvLines(root, {
      productMode: 'attendance',
      assignments: [`PM2_APP_NAME=${customApp}`],
    }), { mode: 0o600 })
    writeFileSync(poison, sentinel, { mode: 0o600 })
    const result = runBash(root, 'scripts/ops/attendance-onprem-package-upgrade.sh', {
      ...baseEnv(root),
      MS_EFFECTIVE_SERVICE_RECEIPT: poison,
      SERVICE_MANAGER: 'pm2',
      INSTALL_DEPS: '0',
      BUILD_WEB: '0',
      BUILD_BACKEND: '0',
      RUN_MIGRATIONS: '1',
      RESTART_SERVICE: '1',
      RELOAD_NGINX: '0',
      RUN_HEALTHCHECK: '0',
      CHECK_NGINX: '0',
    })
    const observed = finish(root, result)
    assert.equal(observed.code, 0)
    assert.equal(observed.sourceCount, 1)
    assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'pm2', target: customApp })
    assert.equal(observed.rows.some(row => row.cmd === 'curl'), false)
    assert.equal(observed.rows.some(row => row.cmd === 'mktemp'), false)
    assert.deepEqual(readFileSync(poison), sentinel)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('effective service carrier receipt is three nul raw fields and ignores decoy', () => {
  assertProtocolPresent()
  const root = mkdtempSync(path.join(tmpdir(), 'plm-effective-service-'))
  try {
    installTree(root)
    writeFileSync(path.join(root, 'app.env'), validEnvLines(root, {
      productMode: 'attendance',
      assignments: [
        `SERVICE_MANAGER=pm2`,
        `PM2_APP_NAME=${customApp}`,
        'builtin printf %s "${MS_EFFECTIVE_SERVICE_RECEIPT-}" > "$FIXTURE_ROOT/requested-receipt"',
      ],
      decoy: true,
    }), { mode: 0o600 })
    const result = runBash(root, 'scripts/ops/attendance-onprem-package-upgrade.sh', {
      ...baseEnv(root),
      SERVICE_MANAGER: 'none',
      INSTALL_DEPS: '0',
      BUILD_WEB: '0',
      BUILD_BACKEND: '0',
      RUN_MIGRATIONS: '1',
      RESTART_SERVICE: '1',
      RELOAD_NGINX: '0',
      RUN_HEALTHCHECK: '1',
      CHECK_NGINX: '0',
    })
    const observed = finish(root, result)
    assert.equal(observed.code, 0)
    assert.equal(observed.sourceCount, 1)
    assert.equal(existsSync(path.join(root, 'decoy-receipt')), false)
    const receipts = observed.rows.filter(row => row.cmd === 'mktemp')
    assert.equal(receipts.length, 1)
    const receiptPath = receipts[0].target
    assert.equal(receiptPath.startsWith(`${root}/`), true)
    assert.equal(existsSync(receiptPath), false, 'owned receipt is removed after health')
    const bytes = readFileSync(path.join(root, 'receipt-before-cleanup'))
    // The child must emit this framing before its final success log. This read is after exit 0.
    assertExact3Nul(bytes, ['pm2', customApp, defaultUnit])
    assert.deepEqual(healthIdentity(observed.rows, observed.output), { manager: 'pm2', target: customApp })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function assertFramingRejected(kind) {
  assertProtocolPresent()
  const root = mkdtempSync(path.join(tmpdir(), 'plm-effective-service-'))
  try {
    installTree(root)
    writeFileSync(path.join(root, 'app.env'), validEnvLines(root, {
      productMode: 'attendance',
      assignments: [`SERVICE_MANAGER=pm2`, `PM2_APP_NAME=${customApp}`],
      framing: kind,
    }), { mode: 0o600 })
    const result = runBash(root, 'scripts/ops/attendance-onprem-package-upgrade.sh', {
      ...baseEnv(root),
      SERVICE_MANAGER: 'none',
      INSTALL_DEPS: '0',
      BUILD_WEB: '0',
      BUILD_BACKEND: '0',
      RUN_MIGRATIONS: '1',
      RESTART_SERVICE: '1',
      RELOAD_NGINX: '0',
      RUN_HEALTHCHECK: '1',
      CHECK_NGINX: '0',
    })
    const observed = finish(root, result)
    const receiptPath = path.join(root, 'tmp', 'mktemp-1')
    assert.notEqual(observed.code, 0)
    assert.equal(observed.output.includes(
      '[attendance-onprem-package-upgrade] ERROR: Effective service receipt must contain exactly three NUL-terminated fields',
    ), true, 'wrapper parser must reject the malformed receipt')
    assert.equal(observed.sourceCount, 1)
    assert.deepEqual(actionIdentity(observed.rows, observed.output), { manager: 'pm2', target: customApp })
    assert.deepEqual(observed.rows.filter(row => row.cmd === 'mktemp').map(row => row.target), [receiptPath])
    const action = observed.rows.findIndex(row => row.cmd === 'pm2' && (row.action === 'restart' || row.action === 'start'))
    assert.equal(action >= 0, true)
    assert.equal(observed.rows.slice(action + 1).some(row =>
      (row.cmd === 'pm2' && (row.action === 'describe' || row.action === 'pid')) ||
      (row.cmd === 'systemctl' && (row.action === 'is-active' || row.action === 'list-unit-files') && !isNginx(row.target))), false)
    assert.equal(observed.rows.some(row => row.cmd === 'curl'), false)
    if (kind === 'missing') {
      assert.equal(observed.rows.some(row => row.cmd === 'rm' && row.action === 'ok' && row.target === receiptPath), true)
    }
    return observed
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('effective service carrier framing truncated receipt rejected', () => {
  assertFramingRejected('truncated')
})

test('effective service carrier framing extra nul receipt rejected', () => {
  assertFramingRejected('extraNul')
})

test('effective service carrier framing trailing non-nul receipt rejected', () => {
  assertFramingRejected('trailingNonNul')
})

test('effective service carrier framing missing receipt rejected', () => {
  assertFramingRejected('missing')
})

test('effective service carrier deploy missing receipt refuses before admin and health', () => {
  const observed = runDeploy({
    SERVICE_MANAGER: 'none',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '0',
    START_SERVICE: '0',
    CHECK_NGINX: '0',
  }, {
    envText: root => validEnvLines(root, { productMode: 'platform', framing: 'missing' }),
  })
  assert.equal(observed.sourceCount, 1)
  const receipt = observed.rows.find(row => row.cmd === 'mktemp' && row.action === 'create')
  assert.notEqual(receipt, undefined, 'wrapper creates its owned receipt')
  assert.equal(observed.rows.some(row => row.cmd === 'rm' && row.action === 'ok' && row.target === receipt.target), true)
  assert.notEqual(observed.code, 0)
  assert.equal(observed.output.includes(
    '[multitable-onprem-deploy-easy] ERROR: Effective service receipt must contain exactly three NUL-terminated fields',
  ), true, 'deploy wrapper parser must reject the missing receipt')
  assert.equal(observed.rows.some(row => row.cmd === 'phase' && row.action === 'admin'), false)
  assert.equal(observed.rows.some(row => row.cmd === 'curl'), false)
  assert.equal(observed.output.includes('[attendance-onprem-healthcheck]'), false)
})

test('effective service carrier direct raw empty pm2 name does not probe default', () => {
  assertProtocolPresent()
  const observed = runDirect('scripts/ops/attendance-onprem-healthcheck.sh', {
    MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY: '1',
    SERVICE_MANAGER: 'pm2',
    PM2_APP_NAME: '',
    SYSTEMD_SERVICE_NAME: defaultUnit,
    BASE_URL: 'http://127.0.0.1:9',
    API_BASE: 'http://127.0.0.1:9/api',
  })
  assert.notEqual(observed.code, 0)
  assert.equal(observed.rows.some(row => row.cmd === 'pm2' && row.target === defaultApp), false)
  assert.equal(observed.rows.some(row => row.cmd === 'pm2'), false)
})

test('effective service carrier direct raw auto manager is rejected', () => {
  assertProtocolPresent()
  const observed = runDirect('scripts/ops/attendance-onprem-healthcheck.sh', {
    MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY: '1',
    SERVICE_MANAGER: 'auto',
    BASE_URL: 'http://127.0.0.1:9',
    API_BASE: 'http://127.0.0.1:9/api',
  })
  assert.notEqual(observed.code, 0)
  assert.equal(observed.rows.some(row => row.cmd === 'pm2' && row.target === defaultApp), false)
})

test('effective service carrier direct raw none keeps url checks without names', () => {
  assertProtocolPresent()
  const observed = runDirect('scripts/ops/attendance-onprem-healthcheck.sh', {
    MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY: '1',
    SERVICE_MANAGER: 'none',
    PM2_APP_NAME: '',
    SYSTEMD_SERVICE_NAME: '',
    BASE_URL: 'http://127.0.0.1:9',
    API_BASE: 'http://127.0.0.1:9/api',
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.rows.some(row => row.cmd === 'pm2' || row.cmd === 'systemctl'), false)
  assert.equal(observed.rows.some(row => row.cmd === 'curl' && row.action === 'check'), true)
})

test('effective service carrier deploy limited branch keeps seeded token off output', () => {
  assertProtocolPresent()
  const observed = runDeploy({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    START_SERVICE: '1',
    CHECK_NGINX: '0',
    VERIFY_LOGIN: '0',
    AUTH_TOKEN: inheritedToken,
    MS_FIXTURE_LOGIN_HTTP: '401',
  }, {
    envText: root => validEnvLines(root, { productMode: 'platform' }),
  })
  assert.equal(observed.code, 0)
  assert.equal(observed.rows.some(row => row.cmd === 'curl' && row.action === 'me'), true)
  assert.equal(observed.output.includes(inheritedToken), false)
})

test('effective service carrier health failure status survives cleanup rm failure', () => {
  // Health die status 1 stays 1 when owned cleanup rm exits 31.
  assertProtocolPresent()
  const observed = runUpgrade({
    SERVICE_MANAGER: 'pm2',
    INSTALL_DEPS: '0',
    BUILD_WEB: '0',
    BUILD_BACKEND: '0',
    RUN_MIGRATIONS: '1',
    RESTART_SERVICE: '1',
    RELOAD_NGINX: '0',
    RUN_HEALTHCHECK: '1',
    CHECK_NGINX: '0',
    MS_FIXTURE_HEALTH_CURL_FAIL: '1',
    MS_FIXTURE_FAIL_RM_AFTER_HEALTH: '1',
  }, {
    envText: root => validEnvLines(root, { productMode: 'attendance', assignments: [`PM2_APP_NAME=${customApp}`] }),
  })
  assert.equal(observed.code, 1)
  assert.equal(observed.rows.some(row => row.cmd === 'rm' && row.action === 'fail'), true)
})


test('effective service manifest receipt is a nonboolean caller-owned output option', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MS_EFFECTIVE_SERVICE_RECEIPT
  assert.equal(spec.type, 'enum')
  assert.equal(spec.danger, 'low')
  assert.deepEqual(spec.dependsOn, [])
  assert.deepEqual(spec.conflictsWith, [])
  assert.equal(spec.source.includes('scripts/ops/attendance-onprem-update.sh#MS_EFFECTIVE_SERVICE_RECEIPT'), true)
  for (const value of [undefined, '', '1', 'true', '/owned/receipt']) assert.equal(isActivated(spec, value), false)
})

test('effective service manifest raw health mode activates only on exact 1', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY
  assert.equal(spec.type, 'boolean')
  assert.equal(spec.activationValue, '1')
  assert.equal(spec.caseInsensitive, false)
  assert.equal(spec.danger, 'low')
  assert.deepEqual(spec.dependsOn, [])
  assert.deepEqual(spec.conflictsWith, [])
  assert.equal(spec.source.includes('scripts/ops/attendance-onprem-healthcheck.sh#MS_HEALTH_EFFECTIVE_SERVICE_IDENTITY'), true)
  assert.equal(isActivated(spec, '1'), true)
  for (const value of [undefined, '', '0', 'true', 'TRUE', ' 1', '1 ']) assert.equal(isActivated(spec, value), false)
})
