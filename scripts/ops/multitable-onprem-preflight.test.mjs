import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/**
 * multitable-onprem-preflight.sh must judge app.env the way the backend loads it.
 *
 * The backend process reads docker/app.env through loadOnPremEnvFile() in ecosystem.config.cjs,
 * which keeps the FIRST declaration of a key. The preflight used to take the LAST one
 * (`grep "^KEY=" | tail -n 1`). The template ships live empty `ENCRYPTION_KEY=` /
 * `ENCRYPTION_SALT=` lines (required by the #5711 template guard), so an operator who appends the
 * real material at the end of the file got a green preflight while the backend read the empty first
 * line and fail-closed at startup (found by the #6131 review, 2026-09-28).
 *
 * This file pins three things:
 *   - the preflight's reader agrees with the REAL ecosystem.config.cjs loader, run as the oracle,
 *     over a battery of line shapes (duplicates, CRLF, BOM, quotes, `export`, inline `#`, ...);
 *   - a key declared more than once is a DUPLICATE_ENV_KEY failure naming keys and line numbers,
 *     including the template-plus-appended-material case built from the shipped template itself;
 *   - no output channel (stdout, stderr, JSON report, Markdown report) ever carries a value.
 *
 * Hermetic and values-free: every env fixture is synthetic and built here, no real env file is
 * read, no network, no npm dependency (bare `node --test`), and no assertion message prints a value.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'ops', 'multitable-onprem-preflight.sh')
const ECOSYSTEM = path.join(ROOT, 'ecosystem.config.cjs')
const TEMPLATE = path.join(ROOT, 'docker', 'app.env.multitable-onprem.template')
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'plugin-tests.yml')

// Windows dev checkouts use core.autocrlf=true while every index blob is LF. Normalize on read so
// the tests judge the committed bytes, and so bash can run the script from a CRLF checkout.
const readLf = file => readFileSync(file, 'utf8').split('\r\n').join('\n')

const shellPath = value =>
  process.platform === 'win32'
    ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    : value

// Synthetic, never real: fixed repeated-hex strings, distinct per role so a leak is attributable.
const SYNTH = {
  key: '9d'.repeat(32),
  salt: 'e3'.repeat(32),
  appendedKey: '71'.repeat(32),
  appendedSalt: '5c'.repeat(32),
  laterKey: 'a8'.repeat(32),
  jwt: 'synthetic-jwt-5a1d2c9e7b3f4e6a8c0b',
  laterJwt: 'synthetic-jwt-later-0f9e8d7c6b5a',
  pg: 'synthetic-pg-8e2b4d6f1a3c5e7d',
}

function validEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PRODUCT_MODE: 'platform',
    ENABLE_PLM: '1',
    DEPLOYMENT_MODEL: 'onprem',
    JWT_SECRET: SYNTH.jwt,
    ENCRYPTION_KEY: SYNTH.key,
    ENCRYPTION_SALT: SYNTH.salt,
    POSTGRES_PASSWORD: SYNTH.pg,
    DATABASE_URL: `postgres://synthetic:${SYNTH.pg}@127.0.0.1:5432/synthetic`,
    ATTENDANCE_IMPORT_REQUIRE_TOKEN: '1',
    ATTENDANCE_IMPORT_UPLOAD_DIR: '/var/lib/synthetic/import',
    ATTACHMENT_PATH: '/var/lib/synthetic/attachments',
    ATTACHMENT_STORAGE_BASE_URL: 'http://127.0.0.1/files',
    ...overrides,
  }
}

const envText = (entries, eol = '\n') =>
  `${Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join(eol)}${eol}`

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Stage the LF script where BASH_SOURCE-relative paths still resolve, then run it on `text`. */
function runPreflight(text, { reports = true } = {}) {
  return withTempDir('mt-onprem-preflight-', dir => {
    const opsDir = path.join(dir, 'scripts', 'ops')
    mkdirSync(opsDir, { recursive: true })
    const staged = path.join(opsDir, 'multitable-onprem-preflight.sh')
    writeFileSync(staged, readLf(SCRIPT))
    const envFile = path.join(dir, 'app.env')
    writeFileSync(envFile, text)
    const jsonFile = path.join(dir, 'out', 'preflight.json')
    const mdFile = path.join(dir, 'out', 'preflight.md')
    const result = spawnSync('bash', [shellPath(staged)], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        HOME: process.env.HOME ?? '',
        ENV_FILE: shellPath(envFile),
        REQUIRE_STORAGE_DIRS: '0',
        ...(reports
          ? { PREFLIGHT_REPORT_JSON: shellPath(jsonFile), PREFLIGHT_REPORT_MD: shellPath(mdFile) }
          : {}),
      },
    })
    if (result.error) throw result.error
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      json: reports && existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : null,
      md: reports && existsSync(mdFile) ? readFileSync(mdFile, 'utf8') : null,
    }
  })
}

/** Values-free leak check: fails naming the channel and the value's role, never the value. */
function assertNoValues(run, roles) {
  const channels = {
    'stdout/stderr': run.output,
    'json report': run.json ? JSON.stringify(run.json) : '',
    'markdown report': run.md ?? '',
  }
  for (const [channel, text] of Object.entries(channels)) {
    for (const role of roles) {
      assert.ok(!text.includes(SYNTH[role]), `the ${role} value leaked into the ${channel}`)
    }
  }
}

function assertFailedWithDuplicate(run, label) {
  assert.equal(run.status, 1, `${label}: preflight must fail (exit ${run.status})`)
  assert.match(run.output, /DUPLICATE_ENV_KEY: /, `${label}: must report DUPLICATE_ENV_KEY`)
  if (run.json) {
    assert.equal(run.json.ok, false, `${label}: json report must not be ok`)
    assert.match(run.json.error, /^DUPLICATE_ENV_KEY: /, `${label}: json error must be the duplicate`)
    assert.ok(
      run.json.suggestedActions.some(action => action.includes('Keep exactly one declaration')),
      `${label}: json report must carry the duplicate repair action`,
    )
  }
  if (run.md) assert.match(run.md, /DUPLICATE_ENV_KEY: /, `${label}: markdown report must carry it`)
}

// ---------------------------------------------------------------------------------------------
// (a) a key declared once: unchanged behaviour
// ---------------------------------------------------------------------------------------------

test('(a) positive control: a complete env with every key declared once passes', () => {
  const run = runPreflight(envText(validEnv()))
  assert.equal(run.status, 0, 'a synthetic-valid env must pass')
  assert.match(run.output, /Preflight OK/)
  assert.doesNotMatch(run.output, /DUPLICATE_ENV_KEY/)
  assert.equal(run.json.ok, true)
  assertNoValues(run, ['key', 'salt', 'jwt', 'pg'])
})

test('(a) single declarations keep their existing verdicts (empty material, change-me, sentinel)', () => {
  const cases = [
    [{ ENCRYPTION_KEY: '' }, /ENCRYPTION_KEY is missing \(empty\)/],
    [{ ENCRYPTION_SALT: '   ' }, /ENCRYPTION_SALT is missing \(empty\)/],
    [{ ENCRYPTION_KEY: 'default-key-change-in-production' }, /ENCRYPTION_KEY uses the insecure built-in default/],
    [{ JWT_SECRET: 'change-me' }, /JWT_SECRET is still 'change-me'/],
    [{ ATTENDANCE_IMPORT_REQUIRE_TOKEN: '0' }, /ATTENDANCE_IMPORT_REQUIRE_TOKEN must be 1/],
  ]
  for (const [overrides, expected] of cases) {
    const run = runPreflight(envText(validEnv(overrides)), { reports: false })
    const label = Object.keys(overrides)[0]
    assert.equal(run.status, 1, `${label}: must fail`)
    assert.match(run.output, expected, `${label}: unexpected verdict`)
    assert.doesNotMatch(run.output, /DUPLICATE_ENV_KEY/, `${label}: a single declaration is not a duplicate`)
  }
})

// ---------------------------------------------------------------------------------------------
// (b) empty first + non-empty later: the silent-empty trap must FAIL, naming the empty first line
// ---------------------------------------------------------------------------------------------

/** The shipped template with its placeholders filled IN PLACE, except the encryption material. */
function templateWithRequiredFieldsFilled() {
  const replacements = {
    JWT_SECRET: SYNTH.jwt,
    POSTGRES_PASSWORD: SYNTH.pg,
    DATABASE_URL: `postgres://synthetic:${SYNTH.pg}@127.0.0.1:5432/synthetic`,
  }
  const seen = new Set()
  const lines = readLf(TEMPLATE)
    .replace(/\n$/, '')
    .split('\n')
    .map(line => {
      const key = line.split('=')[0]
      if (!line.startsWith('#') && key in replacements) {
        seen.add(key)
        return `${key}=${replacements[key]}`
      }
      return line
    })
  assert.deepEqual([...seen].sort(), Object.keys(replacements).sort(), 'template placeholders drifted')
  const keyLine = lines.indexOf('ENCRYPTION_KEY=') + 1
  const saltLine = lines.indexOf('ENCRYPTION_SALT=') + 1
  assert.ok(keyLine > 0 && saltLine > 0, 'the template must still ship live empty ENCRYPTION_KEY=/SALT= lines')
  return { lines, keyLine, saltLine }
}

test('(b) shipped template: material set IN PLACE passes, the same material APPENDED fails as DUPLICATE_ENV_KEY', () => {
  const { lines, keyLine, saltLine } = templateWithRequiredFieldsFilled()

  // Positive control: the documented flow (set the value on the template's own line) passes.
  const inPlace = lines.map(line =>
    line === 'ENCRYPTION_KEY='
      ? `ENCRYPTION_KEY=${SYNTH.key}`
      : line === 'ENCRYPTION_SALT='
        ? `ENCRYPTION_SALT=${SYNTH.salt}`
        : line,
  )
  const ok = runPreflight(`${inPlace.join('\n')}\n`)
  assert.equal(ok.status, 0, 'template with material set in place must pass')
  assertNoValues(ok, ['key', 'salt', 'jwt', 'pg'])

  // The R60 trap: leave the empty template lines, append the real material at the end.
  const appended = [...lines, `ENCRYPTION_KEY=${SYNTH.appendedKey}`, `ENCRYPTION_SALT=${SYNTH.appendedSalt}`]
  const appendedKeyLine = lines.length + 1
  const appendedSaltLine = lines.length + 2
  const run = runPreflight(`${appended.join('\n')}\n`)
  assertFailedWithDuplicate(run, 'template + appended material')
  for (const [key, first, later] of [
    ['ENCRYPTION_KEY', keyLine, appendedKeyLine],
    ['ENCRYPTION_SALT', saltLine, appendedSaltLine],
  ]) {
    assert.ok(
      run.output.includes(
        `${key} appears 2 times (lines ${first}, ${later}); the backend reads the FIRST occurrence (line ${first}), which is EMPTY, and ignores the non-empty value on a later line`,
      ),
      `${key}: the message must name both lines and say the backend reads the empty first one`,
    )
  }
  assertNoValues(run, ['appendedKey', 'appendedSalt', 'jwt', 'pg'])
})

test('(b) any key: an empty first declaration followed by a non-empty one fails, even when the later value is valid', () => {
  for (const key of ['ENCRYPTION_KEY', 'ENCRYPTION_SALT', 'JWT_SECRET', 'ATTENDANCE_IMPORT_REQUIRE_TOKEN']) {
    const base = validEnv()
    const later = base[key]
    base[key] = ''
    const run = runPreflight(`${envText(base)}${key}=${later}\n`, { reports: false })
    const firstLine = Object.keys(base).indexOf(key) + 1
    const laterLine = Object.keys(base).length + 1
    assertFailedWithDuplicate(run, key)
    assert.ok(
      run.output.includes(
        `${key} appears 2 times (lines ${firstLine}, ${laterLine}); the backend reads the FIRST occurrence (line ${firstLine}), which is EMPTY, and ignores the non-empty value on a later line`,
      ),
      `${key}: wrong duplicate message shape`,
    )
    assertNoValues(run, ['key', 'salt', 'jwt', 'pg'])
  }
})

// ---------------------------------------------------------------------------------------------
// (c) non-empty first + non-empty later: still a duplicate; the backend reads the first
// ---------------------------------------------------------------------------------------------

test('(c) two non-empty declarations fail as DUPLICATE_ENV_KEY and name the first line as the one the backend reads', () => {
  const base = validEnv()
  const firstLine = Object.keys(base).indexOf('ENCRYPTION_KEY') + 1
  const text = `${envText(base)}ENCRYPTION_KEY=${SYNTH.laterKey}\n`
  const run = runPreflight(text)
  assertFailedWithDuplicate(run, 'different non-empty values')
  const expected = `ENCRYPTION_KEY appears 2 times (lines ${firstLine}, ${Object.keys(base).length + 1}); the backend reads the FIRST occurrence (line ${firstLine})`
  assert.ok(run.output.includes(`${expected}.`) || run.output.includes(`${expected};`), 'wrong duplicate message shape')
  assert.doesNotMatch(run.output, /EMPTY/, 'a non-empty first declaration must not be reported as empty')
  assertNoValues(run, ['key', 'laterKey', 'salt', 'jwt', 'pg'])

  // Identical repeated values are still rejected: the preflight has one verdict tier (FAIL), and a
  // second declaration is where the next in-place edit silently diverges.
  const same = runPreflight(`${envText(base)}ENCRYPTION_KEY=${SYNTH.key}\n`, { reports: false })
  assertFailedWithDuplicate(same, 'identical values')

  // Several duplicated keys are all named in one run, in file order, with their line lists.
  const many = runPreflight(`${envText(base)}JWT_SECRET=${SYNTH.laterJwt}\nENCRYPTION_KEY=\nJWT_SECRET=\n`, {
    reports: false,
  })
  assertFailedWithDuplicate(many, 'several keys')
  const n = Object.keys(base).length
  const jwtLine = Object.keys(base).indexOf('JWT_SECRET') + 1
  assert.ok(
    many.output.includes(`JWT_SECRET appears 3 times (lines ${jwtLine}, ${n + 1}, ${n + 3})`) &&
      many.output.includes(`ENCRYPTION_KEY appears 2 times (lines ${firstLine}, ${n + 2})`),
    'every duplicated key must be named with all of its lines',
  )
  assert.ok(
    many.output.indexOf('JWT_SECRET appears') < many.output.indexOf('ENCRYPTION_KEY appears'),
    'duplicated keys must be listed in order of first declaration',
  )
  assertNoValues(many, ['key', 'laterJwt', 'jwt', 'pg'])
})

// ---------------------------------------------------------------------------------------------
// (d) CRLF and (e) quoted values, end to end
// ---------------------------------------------------------------------------------------------

test('(d) CRLF app.env: a valid file passes and an appended duplicate is reported with the right lines', () => {
  const ok = runPreflight(envText(validEnv(), '\r\n'), { reports: false })
  assert.equal(ok.status, 0, 'a CRLF-saved valid env must pass (the CR is not part of any value)')

  const base = validEnv({ ENCRYPTION_SALT: '' })
  const firstLine = Object.keys(base).indexOf('ENCRYPTION_SALT') + 1
  const run = runPreflight(`${envText(base, '\r\n')}ENCRYPTION_SALT=${SYNTH.appendedSalt}\r\n`, { reports: false })
  assertFailedWithDuplicate(run, 'CRLF duplicate')
  assert.ok(
    run.output.includes(
      `ENCRYPTION_SALT appears 2 times (lines ${firstLine}, ${Object.keys(base).length + 1}); the backend reads the FIRST occurrence (line ${firstLine}), which is EMPTY`,
    ),
    'CRLF: wrong duplicate message shape',
  )
  assertNoValues(run, ['appendedSalt', 'key', 'jwt', 'pg'])
})

test('(e) quoted values: one quote layer is stripped like the backend does, and a quoted-empty first line is EMPTY', () => {
  const quoted = validEnv({
    ENCRYPTION_KEY: `"${SYNTH.key}"`,
    ENCRYPTION_SALT: `'${SYNTH.salt}'`,
    PRODUCT_MODE: '"platform"',
    ATTENDANCE_IMPORT_REQUIRE_TOKEN: "'1'",
    ATTACHMENT_PATH: '"/var/lib/synthetic/attachments"',
  })
  const ok = runPreflight(envText(quoted), { reports: false })
  assert.equal(ok.status, 0, 'quoted valid values must pass')

  const emptyQuoted = runPreflight(envText(validEnv({ ENCRYPTION_KEY: '""' })), { reports: false })
  assert.equal(emptyQuoted.status, 1)
  assert.match(emptyQuoted.output, /ENCRYPTION_KEY is missing \(empty\)/)

  const base = validEnv({ ENCRYPTION_KEY: '""' })
  const run = runPreflight(`${envText(base)}ENCRYPTION_KEY="${SYNTH.appendedKey}"\n`)
  assertFailedWithDuplicate(run, 'quoted duplicate')
  assert.match(run.output, /ENCRYPTION_KEY appears 2 times \(lines \d+, \d+\); the backend reads the FIRST occurrence \(line \d+\), which is EMPTY/)
  assertNoValues(run, ['appendedKey', 'salt', 'jwt', 'pg'])
})

test('lines the backend loader ignores never count as declarations (comments, keyless, no "=")', () => {
  const ignored = [
    '# ENCRYPTION_KEY=',
    '# ENCRYPTION_KEY=commented-out',
    '   # JWT_SECRET=indented comment',
    '=orphan-value-one',
    '=orphan-value-two',
    'NOT_A_DECLARATION',
    'NOT_A_DECLARATION',
    '',
    '   ',
  ].join('\n')
  const run = runPreflight(`${ignored}\n${envText(validEnv())}`, { reports: false })
  assert.equal(run.status, 0, 'ignored lines must not turn a valid env into a duplicate')
  assert.doesNotMatch(run.output, /DUPLICATE_ENV_KEY/)
})

// ---------------------------------------------------------------------------------------------
// Reader parity: the preflight's get_env_value against the REAL ecosystem.config.cjs loader
// ---------------------------------------------------------------------------------------------

/** Pull a `function name() { ... }` block out of a shell script, verbatim. */
function shellFunctions(source, names) {
  return names
    .map(name => {
      const match = source.match(new RegExp(`^function ${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
      assert.ok(match, `shell function not found: ${name}`)
      return match[0]
    })
    .join('\n')
}

const PARITY_LINES = [
  '\uFEFFPF_BOM=bom-value',
  '# PF_COMMENTED=commented-value',
  'PF_PLAIN=plain-value',
  '   PF_INDENTED=indented-value',
  'PF_SPACED_KEY   =   spaced-value   ',
  'PF_EQ_IN_VALUE=a=b==c',
  'PF_DQ="double quoted value"',
  "PF_SQ='single quoted value'",
  'PF_DQ_EMPTY=""',
  'PF_LONE_QUOTE="',
  `PF_MISMATCHED="mismatched'`,
  `PF_NESTED_QUOTES="'inner'"`,
  'PF_INLINE_HASH=hash-value # stays in the value',
  'PF_WS_ONLY=     ',
  'export PF_EXPORTED=exported-value',
  'PF_CR=cr-value\r',
  'PF_TAB\t=\ttab-value\t',
  'PF_DUP=first-dup-value',
  'PF_DUP=second-dup-value',
  'PF_DUP_EMPTY_FIRST=',
  'PF_DUP_EMPTY_FIRST=later-non-empty-value',
  'PF_DUP_QUOTED_EMPTY_FIRST=""',
  'PF_DUP_QUOTED_EMPTY_FIRST="later quoted value"',
  '=value-without-key',
  'PF_NO_EQUALS',
  '',
  '   ',
]
const PARITY_KEYS = [
  'PF_BOM',
  'PF_COMMENTED',
  '# PF_COMMENTED',
  'PF_PLAIN',
  'PF_INDENTED',
  'PF_SPACED_KEY',
  'PF_EQ_IN_VALUE',
  'PF_DQ',
  'PF_SQ',
  'PF_DQ_EMPTY',
  'PF_LONE_QUOTE',
  'PF_MISMATCHED',
  'PF_NESTED_QUOTES',
  'PF_INLINE_HASH',
  'PF_WS_ONLY',
  'PF_EXPORTED',
  'export PF_EXPORTED',
  'PF_CR',
  'PF_TAB',
  'PF_DUP',
  'PF_DUP_EMPTY_FIRST',
  'PF_DUP_QUOTED_EMPTY_FIRST',
  'PF_NO_EQUALS',
  'PF_NEVER_DECLARED',
]

/** What the backend's loader assigns: run the real ecosystem.config.cjs against `text`. */
function ecosystemOracle(dir, text, keys) {
  const oracleRoot = path.join(dir, 'oracle')
  mkdirSync(path.join(oracleRoot, 'docker'), { recursive: true })
  copyFileSync(ECOSYSTEM, path.join(oracleRoot, 'ecosystem.config.cjs'))
  writeFileSync(path.join(oracleRoot, 'docker', 'app.env'), text)
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const keys = JSON.parse(process.argv[2])',
        'for (const key of keys) delete process.env[key]',
        'require(process.argv[1])',
        'process.stdout.write(JSON.stringify(keys.map(key => (key in process.env ? process.env[key] : null))))',
      ].join('\n'),
      path.join(oracleRoot, 'ecosystem.config.cjs'),
      JSON.stringify(keys),
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } },
  )
  assert.equal(result.status, 0, 'the ecosystem.config.cjs oracle failed to run')
  return JSON.parse(result.stdout)
}

/** What the preflight's reader returns, from the real script's functions. */
function preflightReader(dir, text, keys) {
  const envFile = path.join(dir, 'reader.env')
  writeFileSync(envFile, text)
  const functions = shellFunctions(readLf(SCRIPT), ['parse_env_line', 'get_env_value'])
  const input = [
    'set -euo pipefail',
    `ENV_FILE='${shellPath(envFile)}'`,
    'ENV_DECL_KEY=""',
    'ENV_DECL_VALUE=""',
    functions,
    // No `$(...)` here: MSYS bash strips a trailing CR inside command substitution, which would
    // hide a reader that keeps the CR of a CRLF line on Windows dev hosts.
    'for key in "$@"; do get_env_value "$key"; printf "\\0"; done',
    '',
  ].join('\n')
  const result = spawnSync('bash', ['--noprofile', '--norc', '-s', '--', ...keys], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOME: process.env.HOME ?? '' },
  })
  assert.equal(result.status, 0, 'the preflight reader failed to run')
  const answers = result.stdout.split('\0')
  assert.equal(answers.pop(), '', 'reader output must be NUL-terminated')
  assert.equal(answers.length, keys.length, 'reader must answer every key')
  // get_env_value prints the value plus exactly one newline, as `$(...)` in the script expects.
  return answers.map((answer, index) => {
    assert.ok(answer.endsWith('\n'), `reader answer for ${JSON.stringify(keys[index])} must end with one newline`)
    return answer.slice(0, -1)
  })
}

test('reader parity: get_env_value returns exactly what the real ecosystem.config.cjs loader assigns', () => {
  withTempDir('mt-onprem-reader-', dir => {
    for (const [eol, label] of [
      ['\n', 'LF'],
      ['\r\n', 'CRLF'],
    ]) {
      const text = `${PARITY_LINES.join(eol)}${eol}`
      const oracle = ecosystemOracle(dir, text, PARITY_KEYS)
      const reader = preflightReader(dir, text, PARITY_KEYS)
      PARITY_KEYS.forEach((key, index) => {
        // Undeclared reads as empty in the preflight, exactly as an unset variable would.
        assert.ok(reader[index] === (oracle[index] ?? ''), `${label} ${JSON.stringify(key)}: preflight reader disagrees with ecosystem.config.cjs`)
      })
    }
  })
})

test('(b)/(c) reader: a duplicated key resolves to its FIRST declaration, empty or not', () => {
  withTempDir('mt-onprem-reader-first-', dir => {
    const text = [
      'ENCRYPTION_KEY=',
      `ENCRYPTION_SALT=${SYNTH.salt}`,
      `JWT_SECRET=${SYNTH.jwt}`,
      `ENCRYPTION_KEY=${SYNTH.appendedKey}`,
      `ENCRYPTION_SALT=${SYNTH.appendedSalt}`,
      `JWT_SECRET=${SYNTH.laterJwt}`,
      '',
    ].join('\n')
    const [key, salt, jwt] = preflightReader(dir, text, ['ENCRYPTION_KEY', 'ENCRYPTION_SALT', 'JWT_SECRET'])
    assert.ok(key === '', '(b) ENCRYPTION_KEY: the empty first declaration must win over the appended value')
    assert.ok(salt === SYNTH.salt, '(c) ENCRYPTION_SALT: the first non-empty declaration must win')
    assert.ok(jwt === SYNTH.jwt, '(c) JWT_SECRET: the first non-empty declaration must win')
  })
})

// ---------------------------------------------------------------------------------------------
// CI wiring
// ---------------------------------------------------------------------------------------------

test('CI wiring: this file is invoked by a `node --test` step of the required `test` job', () => {
  const workflow = readLf(WORKFLOW)
  const testJob = workflow.match(/\n {2}test:\n[\s\S]*?(?=\n {2}\S)/)
  assert.ok(testJob, 'the required `test` job must exist in plugin-tests.yml')
  assert.match(
    testJob[0],
    /node --test[^\n]*scripts\/ops\/multitable-onprem-preflight\.test\.mjs/,
    'a preflight contract that no required job runs is a dead tripwire',
  )
})
