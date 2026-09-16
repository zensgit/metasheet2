import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/**
 * Encryption-material preflight contracts (owner review 2026-09-16, F4/F5/F6).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `attendance-onprem-bootstrap-admin.sh` is only ever executed from dispatch-only workflows
 * (`stock-prep-staging-window-rehearsal.yml`) and from an operator's shell on the customer host.
 * Neither runs on a pull request, so a PR that adds a new REQUIRED gate to that script can be
 * fully green while it breaks the rehearsal caller on `main` -- which is exactly what the owner
 * review found (F4: the rehearsal composes its env file without ENCRYPTION_KEY/ENCRYPTION_SALT,
 * so the new gate exits 1 before any DB work). Same shape as the precedent in
 * `.github/workflows/multitable-onprem-package-verify-static-contracts.yml`.
 *
 * Everything here is hermetic and VALUES-FREE:
 *   - no npm dependency (CI runs this with bare `node --test`, no install),
 *   - no network, no Docker, no database,
 *   - every env fixture is synthetic and built by this file; no real env file is read,
 *   - `node`/`psql` are replaced by PATH stubs so even a missed guard cannot reach a database,
 *   - no assertion ever prints a material value (only shapes, exit codes and guard messages).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OPS = path.join(ROOT, 'scripts', 'ops')
const REHEARSAL_WORKFLOW = path.join(
  ROOT,
  '.github',
  'workflows',
  'stock-prep-staging-window-rehearsal.yml',
)

const KEY_SENTINEL = 'default-key-change-in-production'
const SALT_SENTINEL = 'default-salt-change-in-production'
// Synthetic, never a real key: a fixed non-secret hex string used only to exercise accept paths.
const SYNTHETIC_HEX = '3f'.repeat(32)

// This repo is checked out with core.autocrlf=true on Windows dev hosts while every index blob
// is LF. Normalize on read so the contracts judge the committed bytes, not the checkout's EOL.
const read = file => readFileSync(file, 'utf8').split('\r\n').join('\n')

const shellPath = value =>
  process.platform === 'win32'
    ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    : value

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

function makeStubDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'enc-material-stubs-'))
  for (const [name, marker, code] of [
    ['node', 'REACHED_NODE_STUB', 77],
    ['psql', 'REACHED_PSQL_STUB', 78],
  ]) {
    const file = path.join(dir, name)
    writeFileSync(file, `#!/usr/bin/env bash\necho ${marker} >&2\nexit ${code}\n`)
    chmodSync(file, 0o755)
  }
  return dir
}

function runBash({ input, file, args = [], env = {}, cwd = ROOT, stubDir }) {
  const basePath = stubDir ? `${shellPath(stubDir)}:${process.env.PATH}` : process.env.PATH
  const result = spawnSync('bash', input ? ['--noprofile', '--norc', '-s'] : [file, ...args], {
    input,
    cwd,
    encoding: 'utf8',
    env: {
      PATH: basePath,
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      HOME: process.env.HOME ?? '',
      ...env,
    },
  })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

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

/** Minimal, strict YAML step-body reader: no dependency, and it throws when the shape changes. */
function workflowStepRun(text, nameFragment) {
  const lines = text.split('\n')
  const stepIndex = lines.findIndex(
    line => /^\s*- name:/.test(line) && line.includes(nameFragment),
  )
  assert.ok(stepIndex >= 0, `workflow step not found: ${nameFragment}`)
  const stepIndent = lines[stepIndex].indexOf('- ')
  let runIndex = -1
  for (let i = stepIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*- name:/.test(line) && line.indexOf('- ') <= stepIndent) break
    if (/^\s*run: \|\s*$/.test(line)) {
      runIndex = i
      break
    }
  }
  assert.ok(runIndex >= 0, `workflow step has no literal run block: ${nameFragment}`)
  const bodyIndent = lines[runIndex].search(/\S/) + 2
  const body = []
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (line.search(/\S/) < bodyIndent) break
    body.push(line.slice(bodyIndent))
  }
  assert.ok(body.join('\n').trim().length > 0, `empty run block: ${nameFragment}`)
  return body.join('\n')
}

function workflowTopLevelEnv(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line === 'env:')
  assert.ok(start >= 0, 'workflow has no top-level env: block')
  const env = {}
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (!line.startsWith('  ')) break
    const match = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*): (.*)$/)
    if (!match) continue
    env[match[1]] = match[2].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
  }
  assert.ok(Object.keys(env).length > 0, 'workflow top-level env: block parsed empty')
  return env
}

/** A complete, synthetic, otherwise-valid attendance on-prem env file. */
function syntheticEnvFile(overrides = {}) {
  const base = {
    PRODUCT_MODE: 'attendance',
    JWT_SECRET: 'synthetic-preflight-jwt-secret-0123456789abcdef',
    BCRYPT_SALT_ROUNDS: '12',
    POSTGRES_PASSWORD: 'synthetic-postgres-password',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
    ATTENDANCE_IMPORT_REQUIRE_TOKEN: '1',
    ATTENDANCE_IMPORT_UPLOAD_DIR: '/var/lib/synthetic/uploads',
    ATTENDANCE_IMPORT_CSV_MAX_ROWS: '50000',
    ENCRYPTION_KEY: SYNTHETIC_HEX,
    ENCRYPTION_SALT: SYNTHETIC_HEX,
  }
  const merged = { ...base, ...overrides }
  return `${Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// F5 -- the three preflight entry points must judge a material the same way the runtime resolves
// it. `env-file` callers hand over RAW FILE TEXT (never re-parsed by the shell); the bootstrap
// caller hands over an ALREADY-SOURCED value. Both views normalize for the accept/reject decision
// only -- neither rewrites the env file, and neither changes the bytes the app derives a key from.
// ---------------------------------------------------------------------------------------------

const ENV_FILE_VIEW_SCRIPTS = ['attendance-onprem-env-check.sh', 'attendance-preflight.sh']

const ENV_FILE_VIEW_REJECTS = [
  // The four negatives named by the owner review (F5).
  ['quoted-whitespace', '"   "'],
  ['quoted-padded-sentinel', `" ${KEY_SENTINEL} "`],
  ['sentinel-with-inline-comment', `${KEY_SENTINEL} # synthetic comment`],
  ['variable-expansion', '$SOME_VAR'],
  // Additional expressions whose runtime value the preflight cannot know without executing the
  // file. We reject instead of guessing (and instead of eval/source-ing an untrusted file).
  ['command-substitution', '$(printf synthetic)'],
  ['backtick-substitution', '`printf synthetic`'],
  ['unbalanced-quote', `"${SYNTHETIC_HEX}`],
  ['leading-space-before-value', `   ${SYNTHETIC_HEX}`],
  ['empty-with-inline-comment', ' # synthetic comment'],
  // Regressions from the previous round -- a rewrite must not lose them.
  ['bare-empty', ''],
  ['bare-sentinel', KEY_SENTINEL],
  ['quoted-sentinel', `"${KEY_SENTINEL}"`],
  ['single-quoted-sentinel', `'${KEY_SENTINEL}'`],
  ['raw-whitespace', '   '],
  ['crlf-sentinel', `${KEY_SENTINEL}\r`],
]

const ENV_FILE_VIEW_ACCEPTS = [
  ['plain', SYNTHETIC_HEX],
  ['double-quoted', `"${SYNTHETIC_HEX}"`],
  ['single-quoted', `'${SYNTHETIC_HEX}'`],
  ['crlf-terminated', `${SYNTHETIC_HEX}\r`],
]

// The bootstrap caller has already `source`d the file, so `$` and `#` are ordinary characters in
// the resolved value -- rejecting them there would fail-closed on a legitimate operator secret.
const SOURCED_VIEW_REJECTS = [
  ['sourced-whitespace-only', '   '],
  ['sourced-padded-sentinel', ` ${KEY_SENTINEL} `],
  ['sourced-quoted-sentinel', `"${KEY_SENTINEL}"`],
  // What `KEY='" <sentinel> "'` leaves behind after `source`: quotes AND padding survive into the
  // runtime value, so the sentinel compare only works if the re-trim happens after de-quoting.
  ['sourced-quoted-padded-sentinel', `" ${KEY_SENTINEL} "`],
  ['sourced-empty', ''],
  ['sourced-sentinel', KEY_SENTINEL],
  ['sourced-crlf-sentinel', `${KEY_SENTINEL}\r`],
]

const SOURCED_VIEW_ACCEPTS = [
  ['plain', SYNTHETIC_HEX],
  ['contains-dollar', 'synthetic$material-not-an-expansion'],
  ['contains-hash', 'synthetic#material-not-a-comment'],
]

function callMaterialGuard(scriptFile, value, view) {
  const source = read(path.join(OPS, scriptFile))
  const functions = shellFunctions(source, ['die', 'require_encryption_material'])
  const script = [
    'set -euo pipefail',
    'ENV_FILE=synthetic-only-not-a-real-path',
    functions,
    `require_encryption_material ENCRYPTION_KEY ${shellQuote(value)} ${shellQuote(
      KEY_SENTINEL,
    )} ${shellQuote(view)}`,
    'echo GUARD_ACCEPTED',
    '',
  ].join('\n')
  return runBash({ input: script })
}

for (const scriptFile of ENV_FILE_VIEW_SCRIPTS) {
  test(`F5 ${scriptFile}: env-file view rejects every material whose runtime value it cannot vouch for`, () => {
    for (const [label, value] of ENV_FILE_VIEW_REJECTS) {
      const result = callMaterialGuard(scriptFile, value, 'env-file')
      assert.notEqual(result.status, 0, `${label} must be rejected, got: ${result.output}`)
      assert.doesNotMatch(result.output, /GUARD_ACCEPTED/, `${label} must not be accepted`)
      assert.match(result.output, /ENCRYPTION_KEY/, `${label} must name the variable it rejected`)
    }
  })

  test(`F5 ${scriptFile}: env-file view still accepts legitimate quoted/plain material`, () => {
    for (const [label, value] of ENV_FILE_VIEW_ACCEPTS) {
      const result = callMaterialGuard(scriptFile, value, 'env-file')
      assert.equal(result.status, 0, `${label} must be accepted, got: ${result.output}`)
      assert.match(result.output, /GUARD_ACCEPTED/, `${label} must be accepted`)
    }
  })
}

test('F5 attendance-onprem-bootstrap-admin.sh: sourced view rejects whitespace/padded-sentinel material', () => {
  for (const [label, value] of SOURCED_VIEW_REJECTS) {
    const result = callMaterialGuard('attendance-onprem-bootstrap-admin.sh', value, 'sourced')
    assert.notEqual(result.status, 0, `${label} must be rejected, got: ${result.output}`)
    assert.doesNotMatch(result.output, /GUARD_ACCEPTED/, `${label} must not be accepted`)
  }
})

test('F5 attendance-onprem-bootstrap-admin.sh: sourced view does not fail-closed on $ or # inside a resolved secret', () => {
  for (const [label, value] of SOURCED_VIEW_ACCEPTS) {
    const result = callMaterialGuard('attendance-onprem-bootstrap-admin.sh', value, 'sourced')
    assert.equal(result.status, 0, `${label} must be accepted, got: ${result.output}`)
  }
})

test('F5 the material guard is one contract: all three entry points carry the identical function body', () => {
  const bodies = [...ENV_FILE_VIEW_SCRIPTS, 'attendance-onprem-bootstrap-admin.sh'].map(file =>
    shellFunctions(read(path.join(OPS, file)), ['require_encryption_material']),
  )
  for (const body of bodies.slice(1)) {
    assert.equal(body, bodies[0], 'require_encryption_material has drifted between entry points')
  }
  // The view argument must be validated, not silently defaulted: an un-passed view is a bug.
  const result = runBash({
    input: [
      'set -euo pipefail',
      'ENV_FILE=synthetic-only-not-a-real-path',
      shellFunctions(read(path.join(OPS, ENV_FILE_VIEW_SCRIPTS[0])), [
        'die',
        'require_encryption_material',
      ]),
      `require_encryption_material ENCRYPTION_KEY ${shellQuote(SYNTHETIC_HEX)} ${shellQuote(
        KEY_SENTINEL,
      )}`,
      'echo GUARD_ACCEPTED',
      '',
    ].join('\n'),
  })
  assert.notEqual(result.status, 0, `a missing view argument must fail loudly: ${result.output}`)
  assert.doesNotMatch(result.output, /GUARD_ACCEPTED/)
})

test('F5 attendance-onprem-env-check.sh end to end: the whole check agrees with what `source` resolves', () => {
  withTempDir('enc-material-envcheck-', dir => {
    const envFile = path.join(dir, 'app.env')
    const script = path.join(OPS, 'attendance-onprem-env-check.sh')

    // Positive control first: without it, "every negative exits 1" could just mean the harness
    // never reaches the encryption gate at all.
    writeFileSync(envFile, syntheticEnvFile())
    const ok = runBash({ file: script, env: { ENV_FILE: shellPath(envFile) } })
    assert.equal(ok.status, 0, `synthetic-valid env must pass: ${ok.output}`)

    const negatives = [
      ['quoted-whitespace', '"   "', 'RUNTIME_WHITESPACE_ONLY'],
      ['quoted-padded-sentinel', `" ${KEY_SENTINEL} "`, 'RUNTIME_PADDED_SENTINEL'],
      ['sentinel-with-inline-comment', `${KEY_SENTINEL} # synthetic comment`, 'RUNTIME_IS_SENTINEL'],
      ['variable-expansion', '$SOME_UNSET_SYNTHETIC_VAR', 'RUNTIME_IS_EMPTY'],
    ]

    for (const [label, value, expectedRuntime] of negatives) {
      writeFileSync(envFile, syntheticEnvFile({ ENCRYPTION_KEY: value }))
      const result = runBash({ file: script, env: { ENV_FILE: shellPath(envFile) } })
      assert.notEqual(result.status, 0, `${label}: env-check must fail, got: ${result.output}`)
      assert.match(result.output, /ENCRYPTION_KEY/, `${label}: must name ENCRYPTION_KEY`)

      // Runtime oracle: what the on-prem loader (`set -a; . ./docker/app.env`) actually resolves.
      // This is what makes "preflight agrees with runtime" checkable instead of merely asserted.
      const oracle = runBash({
        input: [
          // Exactly bootstrap-admin's load_env_file: `set +u; set -a; source; set +a`.
          // Unset-variable expansion must resolve to empty here, not abort the load.
          'set -e',
          'set +u',
          'set -a',
          `. ${shellQuote(shellPath(envFile))}`,
          'set +a',
          'set -u',
          'value="${ENCRYPTION_KEY:-}"',
          'trimmed="${value#"${value%%[![:space:]]*}"}"',
          'trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"',
          'if [[ -z "$value" ]]; then echo RUNTIME_IS_EMPTY',
          'elif [[ -z "$trimmed" ]]; then echo RUNTIME_WHITESPACE_ONLY',
          `elif [[ "$value" == ${shellQuote(KEY_SENTINEL)} ]]; then echo RUNTIME_IS_SENTINEL`,
          `elif [[ "$trimmed" == ${shellQuote(KEY_SENTINEL)} ]]; then echo RUNTIME_PADDED_SENTINEL`,
          'else echo RUNTIME_IS_OTHER; fi',
          '',
        ].join('\n'),
      })
      assert.equal(oracle.status, 0, `${label}: runtime oracle failed: ${oracle.output}`)
      assert.match(
        oracle.output,
        new RegExp(expectedRuntime),
        `${label}: runtime resolved to something else: ${oracle.output}`,
      )
    }
  })
})

// ---------------------------------------------------------------------------------------------
// F4 -- the rehearsal caller regression. This drives the REAL chain:
//   rehearsal workflow "Compose the env file" step  ->  real bootstrap-admin.sh material gate.
// ---------------------------------------------------------------------------------------------

test('F4 rehearsal caller: the composed env file carries run-scoped material and clears the bootstrap gate', () => {
  const workflow = read(REHEARSAL_WORKFLOW)
  const composeRun = workflowStepRun(workflow, 'Compose the env file')
  const workflowEnv = workflowTopLevelEnv(workflow)

  withTempDir('enc-material-rehearsal-', dir => {
    const pkgRoot = path.join(dir, 'pkgroot')
    const runnerTemp = path.join(dir, 'runner-temp')
    mkdirSync(path.join(pkgRoot, 'docker'), { recursive: true })
    mkdirSync(runnerTemp, { recursive: true })
    // The REAL template the rehearsal unpacks, placed under a synthetic package root.
    writeFileSync(
      path.join(pkgRoot, 'docker', 'app.env.multitable-onprem.template'),
      read(path.join(ROOT, 'docker', 'app.env.multitable-onprem.template')),
    )

    // Substitute only the one GitHub expression we model; anything else must fail loudly rather
    // than be silently mangled into an empty string.
    const composeScript = composeRun.replaceAll(
      '${{ steps.unpack.outputs.pkg_root }}',
      shellPath(pkgRoot),
    )
    assert.doesNotMatch(
      composeScript,
      /\$\{\{/,
      'compose step gained an unmodelled ${{ }} expression; update this contract test',
    )

    const composed = runBash({
      input: composeScript,
      env: {
        RUNNER_TEMP: shellPath(runnerTemp),
        REHEARSAL_PORT: workflowEnv.REHEARSAL_PORT ?? '8931',
        JWT_SECRET: workflowEnv.JWT_SECRET ?? '',
        TENANT_ID: workflowEnv.TENANT_ID ?? '',
      },
    })
    assert.equal(composed.status, 0, `compose step failed: ${composed.output}`)

    const envFile = path.join(pkgRoot, 'docker', 'app.env')

    // Values-free shape check: assert via `source` that the material resolves to something that
    // is neither empty nor a sentinel. The value itself is never read into the test output.
    const oracle = runBash({
      input: [
        // Exactly bootstrap-admin's load_env_file: `set +u; set -a; source; set +a`.
        'set -e',
        'set +u',
        'set -a',
        '. ' + shellQuote(shellPath(envFile)),
        'set +a',
        'set -u',
        'check_material() {',
        '  local label="$1" value="$2" sentinel="$3"',
        '  local trimmed="${value#"${value%%[![:space:]]*}"}"',
        '  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"',
        '  if [[ -z "$trimmed" ]]; then echo "MISSING:${label}"; exit 3; fi',
        '  if [[ "$trimmed" == "$sentinel" ]]; then echo "SENTINEL:${label}"; exit 4; fi',
        '  echo "PRESENT:${label}"',
        '}',
        'check_material ENCRYPTION_KEY "${ENCRYPTION_KEY:-}" ' + shellQuote(KEY_SENTINEL),
        'check_material ENCRYPTION_SALT "${ENCRYPTION_SALT:-}" ' + shellQuote(SALT_SENTINEL),
        '',
      ].join('\n'),
    })
    assert.equal(oracle.status, 0, `composed env lacks usable material: ${oracle.output}`)
    assert.match(oracle.output, /PRESENT:ENCRYPTION_KEY/)
    assert.match(oracle.output, /PRESENT:ENCRYPTION_SALT/)

    // The real caller step (recipe step 5), with node/psql replaced by stubs.
    const stubDir = makeStubDir()
    try {
      const bootstrap = runBash({
        file: path.join(OPS, 'attendance-onprem-bootstrap-admin.sh'),
        cwd: pkgRoot,
        stubDir,
        env: {
          ENV_FILE: shellPath(envFile),
          ADMIN_EMAIL: workflowEnv.ADMIN_EMAIL ?? 'synthetic-admin@ci.invalid',
          ADMIN_PASSWORD: workflowEnv.ADMIN_PASSWORD ?? 'synthetic-admin-password-1',
          ADMIN_NAME: 'Synthetic Contract Admin',
          VERIFY_LOGIN: '0',
        },
      })
      assert.doesNotMatch(
        bootstrap.output,
        /ENCRYPTION_(KEY|SALT) is missing/,
        `rehearsal env is rejected by the bootstrap material gate: ${bootstrap.output}`,
      )
      assert.doesNotMatch(
        bootstrap.output,
        /REACHED_PSQL_STUB/,
        'bootstrap must reach the node hashing step before any SQL',
      )
      assert.match(
        bootstrap.output,
        /REACHED_NODE_STUB/,
        `bootstrap did not get past its own gates: ${bootstrap.output}`,
      )
    } finally {
      rmSync(stubDir, { recursive: true, force: true })
    }
  })
})

test('F4 rehearsal material is minted per run, never a literal committed to the workflow', () => {
  const workflow = read(REHEARSAL_WORKFLOW)
  const composeRun = workflowStepRun(workflow, 'Compose the env file')
  assert.match(
    composeRun,
    /openssl rand -hex 32/,
    'rehearsal material must be generated per run, not hardcoded',
  )
  for (const line of workflow.split('\n')) {
    assert.doesNotMatch(
      line,
      /ENCRYPTION_(KEY|SALT)=[^$\s"']/,
      `workflow must not commit a literal encryption material line: ${line.trim().slice(0, 40)}`,
    )
  }
})

// ---------------------------------------------------------------------------------------------
// F6 -- the package template gate must treat every declaration syntax the Bash `source` path
// honours (optional leading whitespace, optional `export `) as a declaration.
// ---------------------------------------------------------------------------------------------

const PACKAGE_TEMPLATES = [
  'docker/app.env.attendance-onprem.template',
  'docker/app.env.attendance-onprem.ready.env',
  'docker/app.env.example',
]

function runPackageTemplateGuard(extraLinesByTemplate) {
  return withTempDir('enc-material-package-', dir => {
    const pkgRoot = path.join(dir, 'pkgroot')
    mkdirSync(path.join(pkgRoot, 'docker'), { recursive: true })
    for (const rel of PACKAGE_TEMPLATES) {
      const extra = extraLinesByTemplate[rel] ?? ''
      writeFileSync(path.join(pkgRoot, rel), `${read(path.join(ROOT, rel))}${extra}`)
    }
    const source = read(path.join(OPS, 'attendance-onprem-package-verify.sh'))
    const script = [
      'set -euo pipefail',
      shellFunctions(source, ['die', 'verify_onprem_env_templates']),
      `verify_onprem_env_templates ${shellQuote(shellPath(pkgRoot))}`,
      'echo TEMPLATES_ACCEPTED',
      '',
    ].join('\n')
    return runBash({ input: script })
  })
}

test('F6 package template gate: accepts the shipped templates untouched (positive control)', () => {
  const result = runPackageTemplateGuard({})
  assert.equal(result.status, 0, `shipped templates must pass: ${result.output}`)
  assert.match(result.output, /TEMPLATES_ACCEPTED/)
})

test('F6 package template gate: accepts every empty-placeholder declaration syntax', () => {
  const accepts = [
    ['plain-empty', 'ENCRYPTION_KEY=\nENCRYPTION_SALT=\n'],
    ['export-empty', 'export ENCRYPTION_KEY=\nexport ENCRYPTION_SALT=\n'],
    ['indented-empty', '  ENCRYPTION_KEY=\n\tENCRYPTION_SALT=\n'],
    ['indented-export-empty', '  export ENCRYPTION_KEY=\n  export ENCRYPTION_SALT=\n'],
  ]
  for (const [label, extra] of accepts) {
    const result = runPackageTemplateGuard({ 'docker/app.env.example': extra })
    assert.equal(result.status, 0, `${label} must be accepted: ${result.output}`)
  }
})

test('F6 package template gate: rejects every declaration syntax that would ship real material', () => {
  const rejects = [
    ['export-key', 'export ENCRYPTION_KEY=synthetic-value\n'],
    ['export-salt', 'export ENCRYPTION_SALT=synthetic-value\n'],
    ['indented-key', '  ENCRYPTION_KEY=synthetic-value\n'],
    ['tab-indented-salt', '\tENCRYPTION_SALT=synthetic-value\n'],
    ['indented-export-key', '   export ENCRYPTION_KEY=synthetic-value\n'],
    ['export-multiple-spaces', 'export   ENCRYPTION_KEY=synthetic-value\n'],
    // Already covered by the previous round -- kept so a rewrite cannot lose them.
    ['plain-key', 'ENCRYPTION_KEY=synthetic-value\n'],
    ['empty-then-real', 'ENCRYPTION_KEY=\nENCRYPTION_KEY=synthetic-value\n'],
  ]
  for (const [label, extra] of rejects) {
    for (const rel of PACKAGE_TEMPLATES) {
      const result = runPackageTemplateGuard({ [rel]: extra })
      assert.notEqual(result.status, 0, `${label} in ${rel} must be rejected: ${result.output}`)
      assert.doesNotMatch(result.output, /TEMPLATES_ACCEPTED/, `${label} in ${rel}`)
      assert.match(result.output, /ENCRYPTION_(KEY|SALT)/, `${label} in ${rel} must name the key`)
    }
  }
})
