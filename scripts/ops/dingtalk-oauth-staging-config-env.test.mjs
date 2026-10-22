import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, relative, resolve, dirname, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const source = readFileSync(new URL('./dingtalk-oauth-staging-config-remote.sh', import.meta.url), 'utf8')
// Exercise production functions with real Compose parsing and synthetic Docker
// inspect results. Do not dispatch the remote script or allow Engine mutations.
const marker = '\nmkdir -p "$OUTPUT_DIR"\nassert_staging_only\ncase "$ACTION" in'
assert.equal(source.split(marker).length, 2)
const library = source.slice(0, source.indexOf(marker))
const docker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout?.trim()
const compose = process.env.COMPOSE_TEST_BIN || docker
const composePrefix = process.env.COMPOSE_TEST_BIN ? [] : ['compose']
assert.ok(compose, 'real Docker Compose is required; this suite must not skip')
const version = spawnSync(compose, [...composePrefix, 'version', '--short'], { encoding: 'utf8' })
assert.equal(version.status, 0, 'Compose version probe must succeed')
console.log('# Compose parser ' + version.stdout.trim())

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-env-source-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stack = join(dir, ...Array(options.homeRelative ? homedir().split(sep).length : 1).fill('stack'))
  const bin = join(dir, 'bin')
  const privateDir = join(dir, 'private')
  for (const path of [stack, join(stack, 'docker'), bin, privateDir]) mkdirSync(path, { recursive: true })
  const active = options.activeDotenv ? join(stack, '.env') : join(dir, options.dollarPath ? 'runtime $literal #quoted.env' : 'runtime.env')
  const legacy = join(stack, 'docker', 'app.staging.env')
  const candidate = join(privateDir, 'candidate.env')
  const config = join(stack, 'compose.json')
  const sha = 'a'.repeat(40)
  const image = 'ghcr.io/synthetic/metasheet2-backend:' + sha
  const original = "DINGTALK_CLIENT_ID=synthetic-old\nUNRELATED_CONFIG=active-fixture\nACTIVE_ONLY_SETTING='keep # and $literal'\n"
  writeFileSync(active, original)
  writeFileSync(legacy, 'DINGTALK_CLIENT_ID=synthetic-old\nUNRELATED_CONFIG=stale-fixture\n')
  writeFileSync(join(dir, 'client.id'), 'synthetic-client')
  writeFileSync(join(dir, 'client.secret'), 'synthetic-secret')
  const envFiles = [options.interpolated ? '${APP_ENV_FILE:-./docker/app.staging.env}' : active.replaceAll('$', () => '$$')]
  if (options.homeRelative) {
    envFiles[0] = '~/' + relative(homedir(), active)
    if (options.homeShadow) {
      const shadow = resolve(stack, envFiles[0])
      assert.ok(shadow.startsWith(dir + sep), 'shadow fixture must remain inside its owned directory')
      mkdirSync(dirname(shadow), { recursive: true })
      writeFileSync(shadow, original)
    }
  }

  if (options.multiple) {
    const extra = join(dir, 'extra.env')
    writeFileSync(extra, 'EXTRA_SETTING=retained\n')
    envFiles.push(extra)
  }
  if (options.interpolated) writeFileSync(join(stack, '.env'), 'APP_ENV_FILE=' + active + '\n')
  const model = {
    name: 'synthetic-staging',
    services: {
      backend: {
        image, container_name: 'metasheet-staging-backend', env_file: envFiles,
        environment: options.override ? { DINGTALK_CLIENT_ID: 'synthetic-old' } : {},
      },
    },
  }
  if (options.interpolateUnrelated) model.services.backend.hostname = '${DINGTALK_CLIENT_ID}'
  if (options.sharedService) model.services.worker = { image: 'synthetic-worker', env_file: [active] }
  if (options.sharedLabels) model.services.backend.label_file = [active]

  writeFileSync(config, JSON.stringify(model))
  mkdirSync(join(dir, 'alias'))
  const interpolationEnv = options.globalEnv ? join(dir, 'alias', '..', 'runtime.env') : ''
  const composeArgs = [...composePrefix, '--project-directory', stack, '--project-name', 'synthetic-staging', '-f', config]
  if (interpolationEnv) composeArgs.push('--env-file', interpolationEnv)
  const parsed = spawnSync(compose, [...composeArgs, 'config', '--format', 'json'], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, 'real Compose fixture must parse: ' + parsed.stderr)
  const rendered = JSON.parse(parsed.stdout.replaceAll('$$', '$')).services.backend.environment
  assert.equal(rendered.ACTIVE_ONLY_SETTING, 'keep # and $literal', 'fixture uses actual literal env bytes, not Compose serialization escaping')
  const runtime = { IMAGE_DEFAULT: 'retained', ...rendered, ...options.runtime }
  if (options.runtimeDelete) delete runtime[options.runtimeDelete]
  const labels = {
    'com.docker.compose.project.working_dir': options.wrongDirectory ? dir : stack,
    'com.docker.compose.project': 'synthetic-staging',
    'com.docker.compose.project.config_files': options.missingConfig ? join(stack, 'missing.json') : config,
    'com.docker.compose.project.environment_file': interpolationEnv,
  }
  const data = {
    image, labels, runtime: Object.entries(runtime).map(([k, v]) => k + '=' + v),
    imageEnv: ['IMAGE_DEFAULT=retained'], compose, composePrefix, legacyMetadata: options.legacyMetadata, commands: join(dir, 'commands.jsonl'),
  }
  const dataFile = join(dir, 'fixture.json')
  writeFileSync(dataFile, JSON.stringify(data))
  const shim = '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs')
const cp = require('node:child_process')
const f = JSON.parse(fs.readFileSync(process.env.OAUTH_ENV_FIXTURE, 'utf8'))
const a = process.argv.slice(2)
fs.appendFileSync(f.commands, JSON.stringify(a) + '\n')
if (a[0] === 'compose') {
  if (!a.includes('config')) throw new Error('Engine mutation forbidden in fixture')
  const legacy = f.legacyMetadata && a.includes('--no-env-resolution') && !a.includes('--no-interpolate')
  const r = cp.spawnSync(f.compose, [...f.composePrefix, ...a.slice(1)], { stdio: legacy ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (legacy && r.status === 0) {
    const model = JSON.parse(r.stdout)
    for (const service of Object.values(model.services)) delete service.env_file
    process.stdout.write(JSON.stringify(model))
  } else if (legacy) {
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
  }
  process.exit(r.status ?? 1)
}
if (a[0] === 'image' && a[1] === 'inspect') {
  process.stdout.write(JSON.stringify(f.imageEnv))
} else if (a[0] === 'inspect') {
  const format = a[a.indexOf('-f') + 1]
  if (format.includes('.Config.Image')) process.stdout.write(f.image)
  else if (format.includes('.Config.Env')) process.stdout.write(JSON.stringify(f.runtime))
  else {
    const key = format.match(/"([^"]+)"/)?.[1]
    if (!Object.hasOwn(f.labels, key)) throw new Error('unexpected inspect format')
    process.stdout.write(f.labels[key] || '<no value>')
  }
} else {
  throw new Error('Unexpected Docker operation')
}
`
  writeFileSync(join(bin, 'docker'), shim)
  chmodSync(join(bin, 'docker'), 0o755)
  const env = {
    ...process.env, PATH: bin + ':' + process.env.PATH,
    OAUTH_ENV_FIXTURE: dataFile, ACTION: 'prepare', OUTPUT_DIR: dir, RUN_STAMP: 'synthetic',
    STAGING_DEPLOY_PATH: stack, DEPLOY_PATH: join(dir, 'prod'),
    OAUTH_CLIENT_ID_FILE: join(dir, 'client.id'), OAUTH_CLIENT_SECRET_FILE: join(dir, 'client.secret'),
    TEST_PRIVATE: privateDir, TEST_CANDIDATE: candidate, TEST_EXPECTED_SOURCE: active, TEST_SOURCE_CAPTURE: join(dir, 'selected-source'),
  }
  function run(extra = '') {
    const body = library + '\numask 077\nPERSIST_DIR="$TEST_PRIVATE"\nresolve_active_env\n' +
      'printf \'%s\' "$STAGING_ENV_FILE" > "$TEST_SOURCE_CAPTURE"\n[[ "$STAGING_ENV_FILE" == "$TEST_EXPECTED_SOURCE" ]] || exit 97\nbuild_candidate "$TEST_CANDIDATE"\n' +
      extra + '\ncompose_with_env "$TEST_CANDIDATE" config\n'
    return spawnSync('bash', ['-c', body], { env, encoding: 'utf8' })
  }
  return { run, active, legacy, candidate, original, data, sourceCapture: join(dir, 'selected-source') }
}

test('literal active env source preserves unrelated settings and never switches to legacy', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.sourceCapture, 'utf8'), f.active)
  const candidate = readFileSync(f.candidate, 'utf8')
  assert.match(candidate, /UNRELATED_CONFIG=active-fixture/)
  assert.match(candidate, /ACTIVE_ONLY_SETTING='keep # and \$literal'/)
  assert.doesNotMatch(candidate, /stale-fixture/)
  assert.match(candidate, /DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=false/)
  assert.equal(readFileSync(f.active, 'utf8'), f.original)
  assert.match(readFileSync(f.legacy, 'utf8'), /stale-fixture/)
  const commands = readFileSync(f.data.commands, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(commands.every(args => args[0] !== 'compose' || args.includes('config')))
  assert.ok(!commands.some(args => args.includes('run') || args.includes('up')))
})

test('active source follows Compose dotenv interpolation', t => {
  const f = fixture(t, { interpolated: true })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.sourceCapture, 'utf8'), f.active)
  assert.match(readFileSync(f.candidate, 'utf8'), /UNRELATED_CONFIG=active-fixture/)
})

for (const [name, options] of [
  ['multiple source files', { multiple: true }],
  ['different live value', { runtime: { UNRELATED_CONFIG: 'different' } }],
  ['live-only setting', { runtime: { LIVE_ONLY: 'must-not-drop' } }],
  ['missing live setting', { runtimeDelete: 'ACTIVE_ONLY_SETTING' }],
  ['wrong project directory', { wrongDirectory: true }],
  ['missing original Compose file', { missingConfig: true }],
]) {
  test('refuses ' + name + ' before building a candidate', t => {
    const f = fixture(t, options)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /active (env source|Compose)/)
    assert.throws(() => readFileSync(f.candidate), { code: 'ENOENT' })
    assert.equal(readFileSync(f.active, 'utf8'), f.original)
  })
}

test('candidate validation rejects an explicit Compose OAuth override before writing', t => {
  const f = fixture(t, { override: true })
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate changes unrelated configuration or target values are overridden/)
  assert.equal(readFileSync(f.active, 'utf8'), f.original)
})

test('candidate validation rejects change of an unrelated setting', t => {
  const f = fixture(t)
  const result = f.run("printf '\\nUNRELATED_CONFIG=wrong\\n' >> \"$TEST_CANDIDATE\"")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate changes unrelated configuration or target values are overridden/)
  assert.equal(readFileSync(f.active, 'utf8'), f.original)
})

test('active env may also be an explicit interpolation env without losing settings', t => {
  const f = fixture(t, { globalEnv: true })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.sourceCapture, 'utf8'), f.active)
})

for (const [name, options] of [
  ['explicit interpolation env path alias', { globalEnv: true, interpolateUnrelated: true }],
  ['implicit dotenv source', { activeDotenv: true, interpolateUnrelated: true }],
]) {
  test('rejects unrelated interpolated service changes through ' + name, t => {
    const f = fixture(t, options)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /candidate changes unrelated configuration or target values are overridden/)
    assert.equal(readFileSync(f.active, 'utf8'), f.original)
  })
}

test('candidate validation rejects removal of an unrelated setting', t => {
  const f = fixture(t)
  const result = f.run('sed \'/^ACTIVE_ONLY_SETTING=/d\' "$TEST_CANDIDATE" > "$TEST_CANDIDATE.filtered"; mv "$TEST_CANDIDATE.filtered" "$TEST_CANDIDATE"')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate changes unrelated configuration or target values are overridden/)
  assert.equal(readFileSync(f.active, 'utf8'), f.original)
})

for (const [name, options] of [
  ['another service env_file', { sharedService: true }],
  ['backend label_file', { sharedLabels: true }],
]) {
  test('candidate validation rejects active-file reuse by ' + name, t => {
    const f = fixture(t, options)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /candidate changes unrelated configuration or target values are overridden|active env source/)
    assert.equal(readFileSync(f.active, 'utf8'), f.original)
  })
}

test('recovers missing source metadata with Compose interpolation and original paths', t => {
  const f = fixture(t, { legacyMetadata: true, interpolated: true })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.sourceCapture, 'utf8'), f.active)
  assert.match(readFileSync(f.candidate, 'utf8'), /UNRELATED_CONFIG=active-fixture/)
  assert.equal(readFileSync(f.active, 'utf8'), f.original)
})

test('preserves literal dollars and spaces in an env source path through legacy recovery', t => {
  const f = fixture(t, { legacyMetadata: true, dollarPath: true })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.sourceCapture, 'utf8'), f.active)
  assert.match(readFileSync(f.candidate, 'utf8'), /UNRELATED_CONFIG=active-fixture/)
  assert.equal(readFileSync(f.active, 'utf8'), f.original)
})

for (const homeShadow of [false, true]) {
  test('legacy recovery selects the Compose home source' + (homeShadow ? ' despite an identical project shadow' : ''), t => {
    const f = fixture(t, { legacyMetadata: true, homeRelative: true, homeShadow })
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(f.sourceCapture, 'utf8'), f.active)
    assert.match(readFileSync(f.candidate, 'utf8'), /UNRELATED_CONFIG=active-fixture/)
    assert.equal(readFileSync(f.active, 'utf8'), f.original)
  })
}
