import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/**
 * multitable-onprem-preflight.sh must judge app.env the way the backend loads it.
 *
 * The backend process reads docker/app.env through loadOnPremEnvFile() in ecosystem.config.cjs,
 * which keeps the FIRST declaration of a key. The preflight used to take the LAST one
 * (`grep "^KEY=" | tail -n 1`). The template ships live empty `ENCRYPTION_KEY=` /
 * `ENCRYPTION_SALT=` lines (required by the #5711 template guard), so an operator who appends the
 * real material at the end of the file got a green preflight while an ecosystem start read the empty
 * first line and fail-closed at startup (found by the #6131 review, 2026-09-28). Start paths that
 * load the file into the environment first (bootstrap `set -a; source`, the Windows
 * Import-AppEnvFile helpers) let the later line win instead, so a duplicated key is rejected
 * outright and the message never claims which declaration "the backend" reads.
 *
 * This file pins:
 *   - the preflight's reader agrees with the REAL ecosystem.config.cjs loader, run as the oracle,
 *     over a battery of line shapes (duplicates, CRLF, BOM, quotes, `export`, inline `#`, JS
 *     whitespace such as NBSP / U+3000), in the C, UTF-8 and (when present) GBK locales;
 *   - a key declared more than once is a DUPLICATE_ENV_KEY failure that names keys and PHYSICAL
 *     line numbers and says which deletion is safe, including the shipped template with the
 *     material appended, and including a file with a GBK-saved comment read under a UTF-8 locale;
 *   - two declarations are "identical" only when their raw value bytes are equal, so values that
 *     differ only in a no-break space, U+3000 or U+FEFF are reported as DIFFER;
 *   - a UTF-16 / NUL-carrying file and an unreadable file fail with a report instead of passing or
 *     aborting;
 *   - no output channel (stdout, stderr, JSON report, Markdown report) ever carries a value, not
 *     even through the key position: a key is printed only if the shipped template declares it or
 *     it is an upper-case snake-case name with an underscore, at most 64 characters.
 *
 * Hermetic and values-free: every env fixture is synthetic and built here, no real env file is
 * read, no network, no npm dependency (bare `node --test`), and no assertion message prints a value.
 * Non-ASCII code points are built with String.fromCodePoint and non-UTF-8 bytes with byte arrays, so
 * this file stays pure ASCII.
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

const cp = (...codePoints) => String.fromCodePoint(...codePoints)
const NBSP = cp(0xa0)
const IDEOGRAPHIC_SPACE = cp(0x3000)
const BOM = cp(0xfeff)
// Every code point JS String.prototype.trim() removes beyond ASCII whitespace.
const JS_TRIM_NON_ASCII = cp(
  0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
)

const KEY_SENTINEL = 'default-key-change-in-production'
const SALT_SENTINEL = 'default-salt-change-in-production'

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
  dsnLeak: 'synthetic-dsn-secret-4c7a2e9b1d',
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

const lineOf = (entries, key) => Object.keys(entries).indexOf(key) + 1

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Probe: does bash here really switch to `locale`? (An unknown locale silently falls back to C.) */
function bashLocaleWorks(locale, bytes, expectedLength) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', `x=$'${bytes}'; printf '%s' "\${#x}"`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', LC_ALL: locale },
  })
  return result.status === 0 && result.stdout === String(expectedLength)
}
// U+4E2D is E4 B8 AD: 1 character in UTF-8, 2 in GBK (E4B8 + a stray AD), 3 bytes in C.
const UTF8_LOCALE = bashLocaleWorks('C.UTF-8', '\\xe4\\xb8\\xad', 1) ? 'C.UTF-8' : 'en_US.UTF-8'
const GBK_LOCALE = bashLocaleWorks('zh_CN.GBK', '\\xe4\\xb8\\xad', 2) ? 'zh_CN.GBK' : null
const LOCALES = ['C', UTF8_LOCALE, ...(GBK_LOCALE ? [GBK_LOCALE] : [])]

// The UTF-8 locale the CI image (ubuntu-24.04, `test` job of plugin-tests.yml) has: glibc ships
// C.UTF-8 built in. The locale tests below mean nothing in C, so a missing C.UTF-8 FAILS them.
const CI_UTF8_LOCALE = 'C.UTF-8'
function requireCiUtf8Locale() {
  assert.ok(
    bashLocaleWorks(CI_UTF8_LOCALE, '\\xe4\\xb8\\xad', 1),
    `${CI_UTF8_LOCALE} must be available to bash here: these tests only mean something under a UTF-8 locale`,
  )
}

/**
 * Stage the LF script where BASH_SOURCE-relative paths still resolve, then run it on `content`
 * (a string, written as UTF-8, or a Buffer, written verbatim).
 */
function runPreflight(content, { reports = true, locale = null, beforeRun = null } = {}) {
  return withTempDir('mt-onprem-preflight-', dir => {
    const opsDir = path.join(dir, 'scripts', 'ops')
    mkdirSync(opsDir, { recursive: true })
    const staged = path.join(opsDir, 'multitable-onprem-preflight.sh')
    writeFileSync(staged, readLf(SCRIPT))
    const envFile = path.join(dir, 'app.env')
    writeFileSync(envFile, content)
    const jsonFile = path.join(dir, 'out', 'preflight.json')
    const mdFile = path.join(dir, 'out', 'preflight.md')
    const cleanup = beforeRun ? beforeRun(envFile) : null
    try {
      const result = spawnSync('bash', [shellPath(staged)], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          HOME: process.env.HOME ?? '',
          ENV_FILE: shellPath(envFile),
          REQUIRE_STORAGE_DIRS: '0',
          ...(locale ? { LC_ALL: locale } : {}),
          ...(reports
            ? { PREFLIGHT_REPORT_JSON: shellPath(jsonFile), PREFLIGHT_REPORT_MD: shellPath(mdFile) }
            : {}),
        },
      })
      if (result.error) throw result.error
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
        json: reports && existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : null,
        md: reports && existsSync(mdFile) ? readFileSync(mdFile, 'utf8') : null,
      }
    } finally {
      if (cleanup) cleanup()
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

function assertFailedWith(run, prefix, label) {
  assert.equal(run.status, 1, `${label}: preflight must fail (exit ${run.status})`)
  assert.ok(run.output.includes(prefix), `${label}: must report ${JSON.stringify(prefix)}`)
  if (run.json) {
    assert.equal(run.json.ok, false, `${label}: json report must not be ok`)
    assert.ok(run.json.error.startsWith(prefix), `${label}: json error must start with ${JSON.stringify(prefix)}`)
  }
  if (run.md) assert.ok(run.md.includes(prefix), `${label}: markdown report must carry the error`)
}

// For ENCRYPTION_* an EMPTY line is safe to delete only under NODE_ENV=production; stderr says so
// itself, not only the report's suggested actions (outside production that line can be in use).
const MATERIAL_EMPTY_CLAUSE = lines =>
  `EMPTY on line(s) ${lines} -- safe to delete only if this host's backend runs with NODE_ENV=production (it refuses empty material there, so no stored secret depends on an empty line); outside production an empty line can be the material in use (an empty value falls back to the built-in default material, a whitespace-only one can be used as it is), so confirm which material encrypted the stored secrets before deleting; keep one non-empty declaration`
const PLAIN_EMPTY_CLAUSE = lines => `EMPTY on line(s) ${lines} -- safe to delete; keep one non-empty declaration`
const MATERIAL_DIFFER_CLAUSE =
  'the non-empty values DIFFER -- do NOT delete either line until you have confirmed which value encrypted the existing stored secrets'
const WITHHELD = '<key withheld>'

function assertFailedWithDuplicate(run, label) {
  assertFailedWith(run, 'DUPLICATE_ENV_KEY: ', label)
  // The preflight cannot know the host's start path, so it must never claim which one wins.
  assert.doesNotMatch(run.output, /the backend reads/i, `${label}: must not claim which declaration the backend reads`)
  assert.ok(run.output.includes('Start paths disagree on a duplicated key'), `${label}: must explain the start-path split`)
  if (run.json) {
    const actions = run.json.suggestedActions.join('\n')
    assert.ok(actions.includes('start paths disagree on which declaration wins'), `${label}: repair action must be start-path neutral`)
    assert.ok(actions.includes('do NOT delete either line'), `${label}: repair action must carry the ENCRYPTION_* warning`)
    assert.ok(actions.includes('An EMPTY declaration next to a non-empty one is safe to delete'), `${label}: repair action must say which deletion is safe`)
  }
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
    [{ ENCRYPTION_KEY: KEY_SENTINEL }, /ENCRYPTION_KEY uses the insecure built-in default/],
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
// (b) empty first + non-empty later: the silent-empty trap must FAIL; the empty line is safe to go
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
  const run = runPreflight(`${appended.join('\n')}\n`)
  assertFailedWithDuplicate(run, 'template + appended material')
  for (const [key, first, later] of [
    ['ENCRYPTION_KEY', keyLine, lines.length + 1],
    ['ENCRYPTION_SALT', saltLine, lines.length + 2],
  ]) {
    assert.ok(
      run.output.includes(`${key} appears 2 times (lines ${first}, ${later}): ${MATERIAL_EMPTY_CLAUSE(first)}`),
      `${key}: the message must name both lines and say when the empty one is safe to delete`,
    )
  }
  assertNoValues(run, ['appendedKey', 'appendedSalt', 'jwt', 'pg'])
})

test('(b) any key: an empty declaration next to a non-empty one fails and is named as the safe deletion', () => {
  for (const key of ['ENCRYPTION_KEY', 'ENCRYPTION_SALT', 'JWT_SECRET', 'ATTENDANCE_IMPORT_REQUIRE_TOKEN']) {
    const base = validEnv()
    const later = base[key]
    base[key] = ''
    const run = runPreflight(`${envText(base)}${key}=${later}\n`, { reports: false })
    const firstLine = lineOf(base, key)
    const laterLine = Object.keys(base).length + 1
    assertFailedWithDuplicate(run, key)
    const clause = key.startsWith('ENCRYPTION_') ? MATERIAL_EMPTY_CLAUSE(firstLine) : PLAIN_EMPTY_CLAUSE(firstLine)
    assert.ok(
      run.stderr.includes(`${key} appears 2 times (lines ${firstLine}, ${laterLine}): ${clause}`),
      `${key}: wrong duplicate message shape on stderr`,
    )
    assertNoValues(run, ['key', 'salt', 'jwt', 'pg'])
  }

  // Non-empty first, EMPTY later: the empty one is still the one to delete.
  const base = validEnv()
  const run = runPreflight(`${envText(base)}ENCRYPTION_KEY=\n`, { reports: false })
  const n = Object.keys(base).length
  assert.ok(
    run.stderr.includes(`ENCRYPTION_KEY appears 2 times (lines ${lineOf(base, 'ENCRYPTION_KEY')}, ${n + 1}): ${MATERIAL_EMPTY_CLAUSE(n + 1)}`),
    'a later EMPTY declaration must be named as the safe deletion, with the production condition',
  )
})

test('F4 stderr carries the NODE_ENV=production condition for an EMPTY ENCRYPTION_* line, not only the report', () => {
  const base = validEnv({ ENCRYPTION_SALT: '' })
  const n = Object.keys(base).length
  const run = runPreflight(`${envText(base)}ENCRYPTION_SALT=${SYNTH.appendedSalt}\nJWT_SECRET=\n`)
  assertFailedWithDuplicate(run, 'F4')
  const saltLine = lineOf(base, 'ENCRYPTION_SALT')
  assert.ok(
    run.stderr.includes(`ENCRYPTION_SALT appears 2 times (lines ${saltLine}, ${n + 1}): ${MATERIAL_EMPTY_CLAUSE(saltLine)}`),
    'the stderr clause for an EMPTY ENCRYPTION_SALT line must carry the production condition',
  )
  assert.doesNotMatch(run.stderr, /ENCRYPTION_SALT appears[^;]*-- safe to delete;/, 'no unconditional "safe to delete" for ENCRYPTION_*')
  // Other keys keep the unconditional wording: no stored secret is derived from them.
  assert.ok(
    run.stderr.includes(`JWT_SECRET appears 2 times (lines ${lineOf(base, 'JWT_SECRET')}, ${n + 2}): ${PLAIN_EMPTY_CLAUSE(n + 2)}`),
    'a non-material EMPTY line stays unconditionally deletable',
  )
  // The same condition in the report, so stderr and report cannot disagree.
  assert.ok(
    run.json.suggestedActions.some(action => action.includes('this holds on a host whose backend runs with NODE_ENV=production')),
    'the report must carry the same condition',
  )
  assertNoValues(run, ['appendedSalt', 'key', 'jwt', 'pg'])
})

// ---------------------------------------------------------------------------------------------
// (c) non-empty duplicates: the verdict says what is safe, and ENCRYPTION_* is never "just delete"
// ---------------------------------------------------------------------------------------------

test('(c) two DIFFERENT non-empty ENCRYPTION_* values: fail and say do NOT delete either line', () => {
  const base = validEnv()
  const n = Object.keys(base).length
  const run = runPreflight(`${envText(base)}ENCRYPTION_KEY=${SYNTH.laterKey}\nENCRYPTION_SALT=${SYNTH.appendedSalt}\n`)
  assertFailedWithDuplicate(run, 'different ENCRYPTION_* values')
  for (const [key, later] of [
    ['ENCRYPTION_KEY', n + 1],
    ['ENCRYPTION_SALT', n + 2],
  ]) {
    assert.ok(
      run.output.includes(
        `${key} appears 2 times (lines ${lineOf(base, key)}, ${later}): the non-empty values DIFFER -- do NOT delete either line until you have confirmed which value encrypted the existing stored secrets`,
      ),
      `${key}: different material must carry the do-not-delete warning`,
    )
  }
  assert.doesNotMatch(run.output, /EMPTY on line|safe to delete;/, 'no deletion is safe when two non-empty values differ')
  assertNoValues(run, ['key', 'laterKey', 'salt', 'appendedSalt', 'jwt', 'pg'])
})

test('(c) other duplicate shapes: differing non-material values, identical values, all-empty, several keys', () => {
  const base = validEnv()
  const n = Object.keys(base).length

  const jwt = runPreflight(`${envText(base)}JWT_SECRET=${SYNTH.laterJwt}\n`, { reports: false })
  assertFailedWithDuplicate(jwt, 'different JWT_SECRET values')
  assert.ok(
    jwt.output.includes(`JWT_SECRET appears 2 times (lines ${lineOf(base, 'JWT_SECRET')}, ${n + 1}): the non-empty values DIFFER -- confirm which value is intended before deleting a line`),
    'a differing non-material key must ask for confirmation',
  )
  assert.doesNotMatch(jwt.output, /DIFFER -- do NOT delete/, 'the stored-secret warning is for ENCRYPTION_* only')

  // Identical repeated values are still rejected (one verdict tier: FAIL), with the easy fix named.
  const same = runPreflight(`${envText(base)}ENCRYPTION_KEY=${SYNTH.key}\n`, { reports: false })
  assertFailedWithDuplicate(same, 'identical values')
  assert.ok(same.output.includes(`ENCRYPTION_KEY appears 2 times (lines ${lineOf(base, 'ENCRYPTION_KEY')}, ${n + 1}): the declarations are identical -- delete all but one`))

  const allEmpty = runPreflight(`${envText(validEnv({ ENCRYPTION_SALT: '' }))}ENCRYPTION_SALT=  \n`, { reports: false })
  assertFailedWithDuplicate(allEmpty, 'all empty')
  assert.ok(allEmpty.output.includes(`ENCRYPTION_SALT appears 2 times (lines ${lineOf(base, 'ENCRYPTION_SALT')}, ${n + 1}): every declaration is EMPTY`))

  // Several duplicated keys are all named in one run, in file order, with their line lists.
  const many = runPreflight(`${envText(base)}JWT_SECRET=${SYNTH.laterJwt}\nENCRYPTION_KEY=\nJWT_SECRET=\n`, {
    reports: false,
  })
  assertFailedWithDuplicate(many, 'several keys')
  const jwtLine = lineOf(base, 'JWT_SECRET')
  assert.ok(
    many.output.includes(`JWT_SECRET appears 3 times (lines ${jwtLine}, ${n + 1}, ${n + 3})`) &&
      many.output.includes(`ENCRYPTION_KEY appears 2 times (lines ${lineOf(base, 'ENCRYPTION_KEY')}, ${n + 2})`),
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
  const firstLine = lineOf(base, 'ENCRYPTION_SALT')
  const run = runPreflight(`${envText(base, '\r\n')}ENCRYPTION_SALT=${SYNTH.appendedSalt}\r\n`, { reports: false })
  assertFailedWithDuplicate(run, 'CRLF duplicate')
  assert.ok(
    run.output.includes(`ENCRYPTION_SALT appears 2 times (lines ${firstLine}, ${Object.keys(base).length + 1}): EMPTY on line(s) ${firstLine}`),
    'CRLF: wrong duplicate message shape',
  )
  assertNoValues(run, ['appendedSalt', 'key', 'jwt', 'pg'])
})

test('(e) quoted values: one quote layer is stripped like the backend does, and a quoted-empty line is EMPTY', () => {
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
  assert.ok(run.output.includes(`EMPTY on line(s) ${lineOf(base, 'ENCRYPTION_KEY')} -- safe to delete`), 'a quoted-empty line is EMPTY')
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
// Review S3: a value must not leak through the key position
// ---------------------------------------------------------------------------------------------

test('S3 a non-identifier duplicated key is printed as <key withheld>, never verbatim', () => {
  const base = validEnv()
  const n = Object.keys(base).length
  // `KEY: value` instead of `KEY=value`: the first '=' is inside the query string, so the loader's
  // "key" is the whole DSN up to it, secret included.
  const leaky = `DATABASE_URL: postgres://synthetic:${SYNTH.dsnLeak}@127.0.0.1:5432/synthetic?sslmode=disable`
  // A bare hex secret pasted on its own line with a trailing '=' (SYNTH.key starts with a digit).
  const bareHex = `${SYNTH.key}=`
  const run = runPreflight(
    `${envText(base)}${leaky}\n${leaky}\nexport ENCRYPTION_KEY=${SYNTH.laterKey}\nexport ENCRYPTION_KEY=${SYNTH.laterKey}\n${bareHex}\n${bareHex}\n`,
  )
  assertFailedWithDuplicate(run, 'non-identifier keys')
  assert.ok(
    run.output.includes(`${WITHHELD} appears 2 times (lines ${n + 1}, ${n + 2})`) &&
      run.output.includes(`${WITHHELD} appears 2 times (lines ${n + 3}, ${n + 4})`) &&
      run.output.includes(`${WITHHELD} appears 2 times (lines ${n + 5}, ${n + 6})`),
    'non-identifier keys must be labelled, with their line numbers',
  )
  assertNoValues(run, ['dsnLeak', 'laterKey', 'key', 'jwt', 'pg'])
  assert.doesNotMatch(`${run.output}${JSON.stringify(run.json)}${run.md}`, /postgres:\/\/synthetic:/, 'no fragment of the DSN may be printed')
})

// ---------------------------------------------------------------------------------------------
// Review S4: JS whitespace (NBSP, U+3000, ...) is trimmed exactly like the backend trims it
// ---------------------------------------------------------------------------------------------

test('S4 JS whitespace around material is judged as the backend judges it, in every locale', () => {
  // Premises, checked against JS itself: the backend trims these away (normalizeEnvString).
  assert.equal(`${KEY_SENTINEL}${NBSP}`.trim(), KEY_SENTINEL)
  assert.equal(IDEOGRAPHIC_SPACE.trim(), '')
  for (const locale of LOCALES) {
    const cases = [
      [{ ENCRYPTION_KEY: `${KEY_SENTINEL}${NBSP}` }, /ENCRYPTION_KEY uses the insecure built-in default/],
      [{ ENCRYPTION_SALT: `"${SALT_SENTINEL}${NBSP}"` }, /ENCRYPTION_SALT uses the insecure built-in default/],
      [{ ENCRYPTION_KEY: IDEOGRAPHIC_SPACE }, /ENCRYPTION_KEY is missing \(empty\)/],
      [{ ENCRYPTION_SALT: `"${IDEOGRAPHIC_SPACE}${NBSP}"` }, /ENCRYPTION_SALT is missing \(empty\)/],
      [{ ENCRYPTION_KEY: `${JS_TRIM_NON_ASCII}${KEY_SENTINEL}${JS_TRIM_NON_ASCII}` }, /ENCRYPTION_KEY uses the insecure built-in default/],
    ]
    for (const [overrides, expected] of cases) {
      const run = runPreflight(envText(validEnv(overrides)), { reports: false, locale })
      assert.equal(run.status, 1, `${locale} ${Object.keys(overrides)[0]}: must fail`)
      assert.match(run.output, expected, `${locale} ${Object.keys(overrides)[0]}: unexpected verdict`)
    }
    // Positive control: JS whitespace around a real value is not part of it.
    const padded = runPreflight(envText(validEnv({ ENCRYPTION_KEY: `${NBSP}${SYNTH.key}${IDEOGRAPHIC_SPACE}` })), { reports: false, locale })
    assert.equal(padded.status, 0, `${locale}: JS whitespace around a valid value must pass`)
    // A duplicate whose later declaration is only JS whitespace is EMPTY, not a differing value --
    // also inside quotes, where the loader keeps the U+3000 but the backend's check trims it away.
    const base = validEnv()
    const n = Object.keys(base).length
    const dup = runPreflight(`${envText(base)}ENCRYPTION_KEY=${IDEOGRAPHIC_SPACE}\nENCRYPTION_SALT="${IDEOGRAPHIC_SPACE}"\n`, {
      reports: false,
      locale,
    })
    assert.ok(
      dup.output.includes(`ENCRYPTION_KEY appears 2 times (lines ${lineOf(base, 'ENCRYPTION_KEY')}, ${n + 1}): EMPTY on line(s) ${n + 1} -- safe to delete`),
      `${locale}: U+3000-only declaration must count as EMPTY`,
    )
    assert.ok(
      dup.output.includes(`ENCRYPTION_SALT appears 2 times (lines ${lineOf(base, 'ENCRYPTION_SALT')}, ${n + 2}): EMPTY on line(s) ${n + 2} -- safe to delete`),
      `${locale}: a quoted U+3000-only declaration must count as EMPTY`,
    )
  }
})

// ---------------------------------------------------------------------------------------------
// Review S2: a UTF-16 app.env loads nothing in the backend, so it must not pass
// ---------------------------------------------------------------------------------------------

const utf16be = text => {
  const le = Buffer.from(text, 'utf16le')
  for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]]
  return le
}

test('S2 a UTF-16 or NUL-carrying app.env fails as not UTF-8 text; UTF-8 with a BOM still passes', () => {
  const text = envText(validEnv())
  const cases = [
    ['UTF-16LE with BOM (PowerShell 5.1 Out-File)', Buffer.from(`${BOM}${text}`, 'utf16le')],
    ['UTF-16LE without BOM', Buffer.from(text, 'utf16le')],
    // Pure CJK in UTF-16 has no NUL byte at all, so only the byte-order mark gives it away.
    ['UTF-16LE with BOM, no NUL bytes', Buffer.from(`${BOM}${cp(0x4e2d, 0x6587, 0x503c)}`, 'utf16le')],
    ['UTF-16BE with BOM, no NUL bytes', utf16be(`${BOM}${cp(0x4e2d, 0x6587, 0x503c)}`)],
    ['one NUL byte inside UTF-8', Buffer.concat([Buffer.from(text), Buffer.from([0x00]), Buffer.from('\n')])],
  ]
  for (const [label, bytes] of cases) {
    const run = runPreflight(bytes)
    assertFailedWith(run, 'ENV_FILE is not UTF-8 text: ', label)
    // F7: one message for both causes. A single stray NUL in a UTF-8 file is not "UTF-16".
    assert.doesNotMatch(run.stderr, /looks like UTF-16/, `${label}: must not claim the file looks like UTF-16`)
    assert.ok(
      run.stderr.includes('Either it was saved as UTF-16') && run.stderr.includes('or it is UTF-8 with stray NUL bytes'),
      `${label}: the message must name both causes`,
    )
    assert.ok(
      run.json.suggestedActions.some(
        action =>
          action.includes('Re-save app.env as UTF-8 without a byte-order mark') &&
          action.includes('If the file is already UTF-8, remove the stray NUL bytes'),
      ),
      `${label}: must carry the re-save action for both causes`,
    )
    assertNoValues(run, ['key', 'salt', 'jwt', 'pg'])
  }
  const utf8Bom = runPreflight(`${BOM}${text}`, { reports: false })
  assert.equal(utf8Bom.status, 0, 'UTF-8 with a BOM is read fine by the loader (trim drops U+FEFF) and must pass')
})

test('S2 premise: the real ecosystem.config.cjs loader loads nothing from a UTF-16LE app.env', () => {
  withTempDir('mt-onprem-utf16-oracle-', dir => {
    const keys = Object.keys(validEnv())
    const loaded = ecosystemOracle(dir, Buffer.from(`${BOM}${envText(validEnv())}`, 'utf16le'), keys)
    assert.deepEqual(loaded, keys.map(() => null), 'the loader must not recognise any key in a UTF-16 file')
  })
})

// ---------------------------------------------------------------------------------------------
// Review N2: an unreadable app.env fails with a report instead of aborting under `set -e`
// ---------------------------------------------------------------------------------------------

/** Make `file` unreadable for this user; returns a restore function, or null if not possible. */
function makeUnreadable(file) {
  const readable = () => {
    try {
      readFileSync(file)
      return true
    } catch {
      return false
    }
  }
  let restore
  if (process.platform === 'win32') {
    const user = userInfo().username
    const deny = spawnSync('icacls', [file, '/deny', `${user}:(R)`], { encoding: 'utf8' })
    if (deny.status !== 0) return null
    restore = () => spawnSync('icacls', [file, '/remove:d', user], { encoding: 'utf8' })
  } else {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return null
    chmodSync(file, 0o000)
    restore = () => chmodSync(file, 0o600)
  }
  if (readable()) {
    restore()
    return null
  }
  return restore
}

test('N2 an unreadable app.env fails with a JSON/Markdown report instead of a raw abort', t => {
  let prepared = true
  const run = runPreflight(envText(validEnv()), {
    beforeRun: envFile => {
      const restore = makeUnreadable(envFile)
      prepared = restore !== null
      return restore
    },
  })
  if (!prepared) {
    t.skip('cannot make a file unreadable here (running as root, or no ACL support)')
    return
  }
  assertFailedWith(run, 'ENV_FILE is not readable: ', 'unreadable app.env')
  assert.ok(run.json, 'the JSON report must be written')
  assert.ok(
    run.json.suggestedActions.some(action => action.includes('Run the preflight as an account that can read app.env')),
    'must carry the readability action',
  )
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

/** Pull a top-level `NAME=( ... )` array assignment out of a shell script, verbatim. */
function shellArray(source, name) {
  const match = source.match(new RegExp(`^${name}=\\([\\s\\S]*?^\\)`, 'm'))
  assert.ok(match, `shell array not found: ${name}`)
  return match[0]
}

const PARITY_LINES = [
  `${BOM}PF_BOM=bom-value`,
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
  'PF_VT_FF\v\f=\f\vvt-ff-value\v\f',
  'PF_DUP=first-dup-value',
  'PF_DUP=second-dup-value',
  'PF_DUP_EMPTY_FIRST=',
  'PF_DUP_EMPTY_FIRST=later-non-empty-value',
  'PF_DUP_QUOTED_EMPTY_FIRST=""',
  'PF_DUP_QUOTED_EMPTY_FIRST="later quoted value"',
  // JS whitespace (review S4): trimmed at line/key/value edges, kept inside quotes.
  `${NBSP}PF_NBSP_INDENT=nbsp-indent-value`,
  `PF_NBSP_EDGES=${NBSP}nbsp-value${NBSP}`,
  `PF_NBSP_ONLY=${NBSP}`,
  `PF_IDEO_ONLY=${IDEOGRAPHIC_SPACE}`,
  `PF_IDEO_EDGES=${IDEOGRAPHIC_SPACE}ideo-value${IDEOGRAPHIC_SPACE}`,
  `PF_KEY_NBSP${NBSP}=nbsp-key-value`,
  `PF_ALL_JS_SPACE=${JS_TRIM_NON_ASCII} \t${cp(0x4e2d)}js-space-value${cp(0x6587)}${JS_TRIM_NON_ASCII}\t `,
  `PF_CJK_THEN_NBSP=${cp(0x4e2d, 0x6587)}${NBSP}`,
  `PF_QUOTED_NBSP="${NBSP}inner${NBSP}"`,
  // Not JS whitespace: must be KEPT (U+0085 NEL, U+180E MVS, U+200B ZWSP).
  `PF_NEL=${cp(0x85)}nel-value${cp(0x85)}`,
  `PF_MVS=${cp(0x180e)}mvs-value${cp(0x180e)}`,
  `PF_ZWSP=${cp(0x200b)}zwsp-value${cp(0x200b)}`,
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
  'PF_VT_FF',
  'PF_DUP',
  'PF_DUP_EMPTY_FIRST',
  'PF_DUP_QUOTED_EMPTY_FIRST',
  'PF_NBSP_INDENT',
  'PF_NBSP_EDGES',
  'PF_NBSP_ONLY',
  'PF_IDEO_ONLY',
  'PF_IDEO_EDGES',
  'PF_KEY_NBSP',
  'PF_ALL_JS_SPACE',
  'PF_CJK_THEN_NBSP',
  'PF_QUOTED_NBSP',
  'PF_NEL',
  'PF_MVS',
  'PF_ZWSP',
  'PF_NO_EQUALS',
  'PF_NEVER_DECLARED',
]

/** What the backend's loader assigns: run the real ecosystem.config.cjs against `content`. */
function ecosystemOracle(dir, content, keys) {
  const oracleRoot = path.join(dir, 'oracle')
  mkdirSync(path.join(oracleRoot, 'docker'), { recursive: true })
  copyFileSync(ECOSYSTEM, path.join(oracleRoot, 'ecosystem.config.cjs'))
  writeFileSync(path.join(oracleRoot, 'docker', 'app.env'), content)
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

/** What the preflight's reader returns, from the real script's functions, under `locale`. */
function preflightReader(dir, text, keys, locale = 'C') {
  const envFile = path.join(dir, 'reader.env')
  writeFileSync(envFile, text)
  const source = readLf(SCRIPT)
  const input = [
    'set -euo pipefail',
    `ENV_FILE='${shellPath(envFile)}'`,
    'ENV_DECL_KEY=""',
    'ENV_DECL_VALUE=""',
    'JS_TRIMMED=""',
    shellArray(source, 'JS_TRIM_MULTIBYTE'),
    shellFunctions(source, ['js_trim', 'parse_env_line', 'get_env_value']),
    // No `$(...)` here: MSYS bash strips a trailing CR inside command substitution, which would
    // hide a reader that keeps the CR of a CRLF line on Windows dev hosts.
    'for key in "$@"; do get_env_value "$key"; printf "\\0"; done',
    '',
  ].join('\n')
  const result = spawnSync('bash', ['--noprofile', '--norc', '-s', '--', ...keys], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOME: process.env.HOME ?? '', LC_ALL: locale },
  })
  assert.equal(result.status, 0, `the preflight reader failed to run under ${locale}`)
  const answers = result.stdout.split('\0')
  assert.equal(answers.pop(), '', 'reader output must be NUL-terminated')
  assert.equal(answers.length, keys.length, 'reader must answer every key')
  // get_env_value prints the value plus exactly one newline, as `$(...)` in the script expects.
  return answers.map((answer, index) => {
    assert.ok(answer.endsWith('\n'), `reader answer for ${JSON.stringify(keys[index])} must end with one newline`)
    return answer.slice(0, -1)
  })
}

test('reader parity: get_env_value returns exactly what the real ecosystem.config.cjs loader assigns, in every locale', t => {
  if (!GBK_LOCALE) t.diagnostic('zh_CN.GBK is not available to bash here; parity runs in C and UTF-8 only')
  withTempDir('mt-onprem-reader-', dir => {
    for (const [eol, label] of [
      ['\n', 'LF'],
      ['\r\n', 'CRLF'],
    ]) {
      const text = `${PARITY_LINES.join(eol)}${eol}`
      const oracle = ecosystemOracle(dir, text, PARITY_KEYS)
      for (const locale of LOCALES) {
        const reader = preflightReader(dir, text, PARITY_KEYS, locale)
        PARITY_KEYS.forEach((key, index) => {
          // Undeclared reads as empty in the preflight, exactly as an unset variable would.
          assert.ok(
            reader[index] === (oracle[index] ?? ''),
            `${label} ${locale} ${JSON.stringify(key)}: preflight reader disagrees with ecosystem.config.cjs`,
          )
        })
      }
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
// Round-2 F1: the file is read byte-wise (LC_ALL=C) whatever the operator's locale, so a comment
// saved in GBK cannot swallow the next line, and every reported line number is a physical one
// ---------------------------------------------------------------------------------------------

// '# ' + two CJK characters saved in GBK. The last byte (0xDC) is a UTF-8 lead byte, so under a
// UTF-8 locale bash 5.2's `read` takes the LF after it as the rest of that character and swallows
// the next line into the comment.
const GBK_COMMENT = Buffer.from([0x23, 0x20, 0xbc, 0xd3, 0xc3, 0xdc])

/** LF-join lines (strings or Buffers); `physical[i]` is physical line i + 1, one char per byte. */
function lfFile(parts) {
  const bytes = Buffer.concat(parts.flatMap(part => [Buffer.isBuffer(part) ? part : Buffer.from(part), Buffer.from('\n')]))
  return { bytes, physical: bytes.toString('latin1').split('\n') }
}

function physicalLineOf(physical, text) {
  const index = physical.indexOf(text)
  assert.ok(index >= 0, 'fixture line not found')
  return index + 1
}

/** Diagnostic only: does a bare `read` loop under `locale` swallow the line after `lineBytes`? */
function bashReadSwallows(locale, lineBytes) {
  return withTempDir('mt-onprem-read-probe-', dir => {
    const file = path.join(dir, 'probe.env')
    writeFileSync(file, Buffer.concat([lineBytes, Buffer.from('\nPROBE_NEXT=1\n')]))
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-c', 'n=0; while IFS= read -r l; do n=$((n + 1)); done < "$1"; printf %s "$n"', '_', shellPath(file)],
      { encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', LC_ALL: locale } },
    )
    return result.stdout !== '2'
  })
}

function localePremise(t) {
  requireCiUtf8Locale()
  const swallows = bashReadSwallows(CI_UTF8_LOCALE, GBK_COMMENT)
  t.diagnostic(
    `premise: a bare read loop under ${CI_UTF8_LOCALE} ${swallows ? 'DOES' : 'does NOT'} swallow the line after a GBK comment on this bash (bash 5.2 on the CI image does)`,
  )
}

test('F1 a GBK comment directly above a duplicated key: still DUPLICATE_ENV_KEY, physical lines, under C.UTF-8 and C', t => {
  localePremise(t)
  const entries = Object.entries(validEnv({ ENCRYPTION_KEY: '' })).map(([key, value]) => `${key}=${value}`)
  const at = entries.indexOf('ENCRYPTION_KEY=')
  const appended = `ENCRYPTION_KEY=${SYNTH.appendedKey}`
  const { bytes, physical } = lfFile([...entries.slice(0, at), GBK_COMMENT, ...entries.slice(at), appended])
  const emptyLine = physicalLineOf(physical, 'ENCRYPTION_KEY=')
  const laterLine = physicalLineOf(physical, appended)
  for (const locale of [CI_UTF8_LOCALE, 'C']) {
    const run = runPreflight(bytes, { locale })
    assertFailedWithDuplicate(run, `${locale}: GBK comment above the empty line`)
    assert.ok(
      run.stderr.includes(`ENCRYPTION_KEY appears 2 times (lines ${emptyLine}, ${laterLine}): ${MATERIAL_EMPTY_CLAUSE(emptyLine)}`),
      `${locale}: both declarations must be seen, at their physical line numbers`,
    )
    assertNoValues(run, ['appendedKey', 'salt', 'jwt', 'pg'])
  }
})

test('F1 a GBK comment directly above the first of two different values: still DIFFER, physical lines, under C.UTF-8 and C', t => {
  localePremise(t)
  const entries = Object.entries(validEnv()).map(([key, value]) => `${key}=${value}`)
  const first = `ENCRYPTION_KEY=${SYNTH.key}`
  const later = `ENCRYPTION_KEY=${SYNTH.laterKey}`
  const at = entries.indexOf(first)
  const { bytes, physical } = lfFile([...entries.slice(0, at), GBK_COMMENT, ...entries.slice(at), later])
  const firstLine = physicalLineOf(physical, first)
  const laterLine = physicalLineOf(physical, later)
  for (const locale of [CI_UTF8_LOCALE, 'C']) {
    const run = runPreflight(bytes, { locale })
    assertFailedWithDuplicate(run, `${locale}: GBK comment above the first value`)
    assert.ok(
      run.stderr.includes(`ENCRYPTION_KEY appears 2 times (lines ${firstLine}, ${laterLine}): ${MATERIAL_DIFFER_CLAUSE}`),
      `${locale}: two different values must be reported as DIFFER at their physical line numbers`,
    )
    assertNoValues(run, ['key', 'laterKey', 'salt', 'jwt', 'pg'])
  }
})

test('F1 a GBK comment near the top: the line called EMPTY is the physically empty one, not the value above it', t => {
  localePremise(t)
  const entries = Object.entries(validEnv({ ENCRYPTION_KEY: '' })).map(([key, value]) => `${key}=${value}`)
  const at = entries.indexOf('ENCRYPTION_KEY=')
  // The operator put the value on a NEW line directly above the template's empty line.
  const value = `ENCRYPTION_KEY=${SYNTH.key}`
  const { bytes, physical } = lfFile([GBK_COMMENT, ...entries.slice(0, at), value, ...entries.slice(at)])
  const valueLine = physicalLineOf(physical, value)
  const emptyLine = physicalLineOf(physical, 'ENCRYPTION_KEY=')
  assert.equal(emptyLine, valueLine + 1, 'fixture: the empty line sits directly below the value')
  for (const locale of [CI_UTF8_LOCALE, 'C']) {
    const run = runPreflight(bytes, { locale })
    assertFailedWithDuplicate(run, `${locale}: GBK comment near the top`)
    const named = run.stderr.match(/ENCRYPTION_KEY appears 2 times \(lines [0-9, ]+\): EMPTY on line\(s\) ([0-9]+) /)
    assert.ok(named, `${locale}: an EMPTY line must be named`)
    assert.equal(physical[Number(named[1]) - 1], 'ENCRYPTION_KEY=', `${locale}: the line called EMPTY must be the empty declaration`)
    assert.ok(
      run.stderr.includes(`ENCRYPTION_KEY appears 2 times (lines ${valueLine}, ${emptyLine}): ${MATERIAL_EMPTY_CLAUSE(emptyLine)}`),
      `${locale}: reported line numbers must be the physical ones`,
    )
    assertNoValues(run, ['key', 'salt', 'jwt', 'pg'])
  }
})

test('F1 structure: every read loop over the env file sits in a function whose first statement is local LC_ALL=C', () => {
  const source = readLf(SCRIPT)
  const loops = [...source.matchAll(/^[ \t]*done < "\$ENV_FILE"$/gm)]
  assert.ok(loops.length >= 2, 'expected the read loops of get_env_value and require_unique_env_keys')
  for (const loop of loops) {
    const head = source.lastIndexOf('\nfunction ', loop.index)
    assert.ok(head >= 0, 'a read loop over the env file must sit inside a function')
    const [signature, firstStatement] = source.slice(head + 1).split('\n')
    assert.equal(firstStatement.trim(), 'local LC_ALL=C', `${signature.trim()} must start with local LC_ALL=C`)
  }
})

// ---------------------------------------------------------------------------------------------
// Round-2 F2: "identical" means equal raw value bytes; matching after a trim is not enough
// ---------------------------------------------------------------------------------------------

test('F2 premise: JS trim drops NBSP / U+3000 / U+FEFF, but bash `set -a; source` keeps them in an unquoted value', () => {
  for (const ch of [NBSP, IDEOGRAPHIC_SPACE, BOM]) assert.equal(`${ch}x${ch}`.trim(), 'x')
  withTempDir('mt-onprem-source-', dir => {
    const file = path.join(dir, 'source.env')
    writeFileSync(file, [`PF_NBSP=x${NBSP}`, `PF_IDEO=x${IDEOGRAPHIC_SPACE}`, `PF_BOM=x${BOM}`, 'PF_PLAIN=x', ''].join('\n'))
    for (const locale of ['C', CI_UTF8_LOCALE]) {
      const result = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          'set -a; . "$1"; LC_ALL=C; printf "%s %s %s %s" "${#PF_NBSP}" "${#PF_IDEO}" "${#PF_BOM}" "${#PF_PLAIN}"',
          '_',
          shellPath(file),
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', LC_ALL: locale } },
      )
      // Byte lengths: 'x' + 2 / 3 / 3 bytes; the plain control is 1.
      assert.equal(result.stdout, '3 4 4 1', `${locale}: sourcing must keep the character in the value`)
    }
  })
})

test('F2 values that differ only in NBSP / U+3000 / U+FEFF (start or end, either order) are DIFFER, never identical', () => {
  for (const [name, ch] of [
    ['NBSP', NBSP],
    ['U+3000', IDEOGRAPHIC_SPACE],
    ['U+FEFF', BOM],
  ]) {
    for (const [where, pad] of [
      ['start', value => `${ch}${value}`],
      ['end', value => `${value}${ch}`],
    ]) {
      // ENCRYPTION_KEY: plain first, padded copy later. ENCRYPTION_SALT: padded first, plain later.
      const base = validEnv({ ENCRYPTION_SALT: pad(SYNTH.salt) })
      const n = Object.keys(base).length
      const run = runPreflight(`${envText(base)}ENCRYPTION_KEY=${pad(SYNTH.key)}\nENCRYPTION_SALT=${SYNTH.salt}\n`, {
        reports: false,
        locale: CI_UTF8_LOCALE,
      })
      const label = `${name} at the ${where}`
      assertFailedWithDuplicate(run, label)
      for (const [key, later, order] of [
        ['ENCRYPTION_KEY', n + 1, 'plain first'],
        ['ENCRYPTION_SALT', n + 2, 'padded first'],
      ]) {
        assert.ok(
          run.stderr.includes(`${key} appears 2 times (lines ${lineOf(base, key)}, ${later}): ${MATERIAL_DIFFER_CLAUSE}`),
          `${label}, ${order}: ${key} must be reported as DIFFER`,
        )
      }
      assert.doesNotMatch(run.stderr, /identical -- delete all but one/, `${label}: must never say "delete all but one"`)
      assertNoValues(run, ['key', 'salt', 'jwt', 'pg'])
    }
  }

  // Quotes are not proven equivalent either: only equal raw bytes count as identical.
  const base = validEnv()
  const quoted = runPreflight(`${envText(base)}JWT_SECRET="${SYNTH.jwt}"\n`, { reports: false })
  assert.ok(
    quoted.stderr.includes(
      `JWT_SECRET appears 2 times (lines ${lineOf(base, 'JWT_SECRET')}, ${Object.keys(base).length + 1}): the non-empty values DIFFER -- confirm which value is intended before deleting a line`,
    ),
    'a quoted and an unquoted copy are not byte-identical',
  )
  assertNoValues(quoted, ['jwt', 'key', 'salt', 'pg'])
})

// ---------------------------------------------------------------------------------------------
// Round-2 F3: a key is printed only if the template declares it or it is an UPPER_SNAKE name with
// an underscore, at most 64 characters; anything else is <key withheld>, with its line numbers
// ---------------------------------------------------------------------------------------------

/** A fresh random string of `shape`, generated here (never a pasted literal). */
function synthetic(generate, shape) {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const candidate = generate()
    if (shape.test(candidate)) return candidate
  }
  throw new Error('could not generate a synthetic value of the requested shape')
}

/** Values-free: no 8-character window of `secret` may appear in any output channel. */
function assertNoFragments(run, secret, label) {
  const channels = {
    stdout: run.stdout,
    stderr: run.stderr,
    'json report': run.json ? JSON.stringify(run.json) : '',
    'markdown report': run.md ?? '',
  }
  for (const [channel, text] of Object.entries(channels)) {
    for (let i = 0; i + 8 <= secret.length; i++) {
      assert.ok(!text.includes(secret.slice(i, i + 8)), `${label}: an 8-character fragment of the value leaked into the ${channel}`)
    }
  }
}

test('F3 value-shaped text before the first "=" is never printed as a key (the reproduced leaks)', () => {
  const alnum = /[^A-Za-z0-9]/g
  const shapes = [
    [
      'letter-first base64 with one "=" pad, alone on a line',
      synthetic(() => randomBytes(32).toString('base64'), /^[A-Za-z][A-Za-z0-9]{42}=$/),
      secret => secret,
    ],
    [
      'letter-first base64 with "==" pad, alone on a line',
      synthetic(() => randomBytes(31).toString('base64'), /^[A-Za-z][A-Za-z0-9]{41}==$/),
      secret => secret,
    ],
    ['letter-first lower-case hex then "=value"', synthetic(() => randomBytes(32).toString('hex'), /^[a-f]/), secret => `${secret}=value1`],
    [
      'letter-first upper-case hex then "=value"',
      synthetic(() => randomBytes(32).toString('hex').toUpperCase(), /^[A-F]/),
      secret => `${secret}=value1`,
    ],
    ['identifier glued to a secret (the "=" forgotten)', `q${randomBytes(12).toString('hex')}`, secret => `JWT_SECRET${secret}=`],
    [
      '300-character identifier-shaped string then "="',
      `Z${randomBytes(400).toString('base64').replace(alnum, '').slice(0, 299)}`,
      secret => `${secret}=v`,
    ],
  ]
  assert.equal(shapes[5][1].length, 300, 'fixture: the long string must be 300 characters')
  const lines = shapes.flatMap(([, secret, line]) => [line(secret), '# spacer', line(secret)])
  const base = validEnv()
  const n = Object.keys(base).length
  for (const locale of [CI_UTF8_LOCALE, 'C']) {
    const run = runPreflight(`${envText(base)}${lines.join('\n')}\n`, { locale })
    assertFailedWithDuplicate(run, `${locale}: value-shaped keys`)
    shapes.forEach(([label, secret], index) => {
      assertNoFragments(run, secret, `${locale} ${label}`)
      const first = n + 1 + index * 3
      assert.ok(
        run.stderr.includes(`${WITHHELD} appears 2 times (lines ${first}, ${first + 2})`),
        `${locale} ${label}: must be shown as ${WITHHELD} with its line numbers`,
      )
    })
    assert.ok(run.stderr.includes(`A key shown as ${WITHHELD} is not printed because its text could be part of a value`), 'stderr must explain the placeholder')
    assert.ok(
      run.json.suggestedActions.some(action => action.includes(`A key shown as ${WITHHELD} is not printed`)),
      'the report must explain the placeholder',
    )
  }
})

test('F3 which keys print: template keys and UPPER_SNAKE names up to 64 characters; TZ-like keys are withheld (known cost)', () => {
  const upper64 = `A_${'B'.repeat(62)}`
  const upper65 = `A_${'B'.repeat(63)}`
  const duplicated = ['HOST', 'CUSTOM_FEATURE_FLAG', upper64, 'TZ', upper65, 'Custom_Flag', 'LEADING__DOUBLE', 'TRAILING_']
  const base = validEnv()
  const n = Object.keys(base).length
  const lines = duplicated.flatMap(key => [`${key}=1`, `${key}=1`])
  const run = runPreflight(`${envText(base)}${lines.join('\n')}\n`, { reports: false })
  assertFailedWithDuplicate(run, 'key label rule')
  const printed = new Set(['HOST', 'CUSTOM_FEATURE_FLAG', upper64])
  duplicated.forEach((key, index) => {
    const first = n + 1 + index * 2
    const label = printed.has(key) ? key : WITHHELD
    assert.ok(
      run.stderr.includes(`${label} appears 2 times (lines ${first}, ${first + 1}): the declarations are identical -- delete all but one`),
      `key #${index + 1} (${printed.has(key) ? 'printed' : 'withheld'}): wrong label or line numbers`,
    )
  })
  for (const key of ['TZ', upper65, 'Custom_Flag', 'LEADING__DOUBLE', 'TRAILING_']) {
    assert.ok(!run.output.includes(`${key} appears`), `a key outside the rule must not be printed (${key.length} characters)`)
  }
})

test('F3 the embedded template key list matches docker/app.env.multitable-onprem.template', () => {
  const embedded = shellArray(readLf(SCRIPT), 'ENV_TEMPLATE_KEYS')
    .replace(/^ENV_TEMPLATE_KEYS=\(/, '')
    .replace(/\)$/, '')
    .trim()
    .split(/\s+/)
  const declared = readLf(TEMPLATE)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.indexOf('=') > 0)
    .map(line => line.slice(0, line.indexOf('=')).trim())
  assert.equal(new Set(embedded).size, embedded.length, 'the embedded list must not repeat a key')
  assert.deepEqual([...embedded].sort(), [...new Set(declared)].sort(), 'ENV_TEMPLATE_KEYS drifted from the template')
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
