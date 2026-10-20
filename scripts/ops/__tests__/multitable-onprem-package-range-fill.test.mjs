// multitable-onprem-package-range-fill.test.mjs — the offline package builds the web app with the
// multitable range-fill switch ON (owner decision 2026-10-18, #6079).
//
// WHAT THIS PINS:
//   * scripts/ops/multitable-onprem-package-build.sh defaults VITE_MULTITABLE_RANGE_FILL_ENABLED to
//     true, passes ONLY the literal true to its own web build (BUILD_WEB=1), and builds with the
//     variable removed for false.
//   * any other value (empty, TRUE, 1, padded) stops the script before pnpm is ever called.
//   * the PACKAGED web dist must carry the same baked value: assert_packaged_web_range_fill is run
//     here for real (extracted from the script) against fixture dists, and its call site sits
//     between staging the payload and writing BUILD_PROVENANCE.json, which records the value.
//   * the byte probe (scripts/ops/multitable-onprem-web-range-fill-probe.mjs) answers on / off /
//     unknown from the minified shape and never from the toolbar text alone.
//   * every workflow that builds the web app and then packages it with BUILD_WEB=0 sets the literal
//     'true' on its web build step, and the other deploy routes keep their default OFF.
//
// The script is run as a real `bash` subprocess with a fake `pnpm` first on PATH that records the
// switch it was handed and exits 97, so the run stops at the first pnpm call and never packages.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  RANGE_FILL_BAKED_DEFAULT_SHAPE,
  RANGE_FILL_TOOLBAR_TEXT,
  probeRangeFill,
} from '../multitable-onprem-web-range-fill-probe.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const buildScriptPath = path.join(repoRoot, 'scripts/ops/multitable-onprem-package-build.sh')
const probePath = path.join(repoRoot, 'scripts/ops/multitable-onprem-web-range-fill-probe.mjs')
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')
const buildScript = readRepo('scripts/ops/multitable-onprem-package-build.sh')
const LITERAL_ERROR = '[multitable-onprem-package-build] ERROR: VITE_MULTITABLE_RANGE_FILL_ENABLED must be literal true or false\n'

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A dist whose one JS chunk carries the toolbar text and the given baked defaults.
function writeDist(root, { bakedDefaults = ['"true"'], toolbar = true, assets = true } = {}) {
  const dist = path.join(root, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  if (!assets) return dist
  fs.mkdirSync(path.join(dist, 'assets'))
  const body = [
    'const a=1;',
    toolbar ? `const t="${RANGE_FILL_TOOLBAR_TEXT}。最多 1,000 格；填充不支持撤销。";` : '',
    ...bakedDefaults.map((value, index) => `function J${index}(e=${value}){return e==="true"}`),
    // Neighbours that must NOT count: a different comparison and a non-default reader.
    'function K(e="true"){return e==="false"}',
    'function L(){return"".trim().toLowerCase()==="true"}',
  ].join('')
  fs.writeFileSync(path.join(dist, 'assets', 'MultitableEmbedHost-abc123.js'), body)
  fs.writeFileSync(path.join(dist, 'assets', 'index-def456.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
  return dist
}

function scriptEnv(t, overrides = {}) {
  const bin = tmpDir(t, 'ms2-rangefill-bin-')
  const log = path.join(bin, 'pnpm.log')
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/usr/bin/env bash\n'
      + 'printf \'ARGS=%s RANGE=%s\\n\' "$*" "${VITE_MULTITABLE_RANGE_FILL_ENABLED-<unset>}" >> "$FAKE_PNPM_LOG"\n'
      + 'exit 97\n',
    { mode: 0o755 },
  )
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`
  delete env.VITE_MULTITABLE_RANGE_FILL_ENABLED
  Object.assign(env, {
    FAKE_PNPM_LOG: log,
    OUTPUT_DIR: tmpDir(t, 'ms2-rangefill-out-'),
    INSTALL_DEPS: '0',
    BUILD_WEB: '1',
    BUILD_BACKEND: '0',
    ...overrides,
  })
  return { env, log }
}

function runBuildScript(env) {
  return spawnSync('bash', [buildScriptPath], { cwd: repoRoot, env, encoding: 'utf8' })
}

function pnpmCalls(log) {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

// --- the script's own web build -------------------------------------------------------------

test('default: an unset switch reaches the web build as the literal true', (t) => {
  const { env, log } = scriptEnv(t)
  const result = runBuildScript(env)
  assert.equal(result.status, 97, result.stderr)
  assert.deepEqual(pnpmCalls(log), ['ARGS=--filter @metasheet/web build RANGE=true'])
})

test('explicit true reaches the web build as the literal true', (t) => {
  const { env, log } = scriptEnv(t, { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true' })
  const result = runBuildScript(env)
  assert.equal(result.status, 97, result.stderr)
  assert.deepEqual(pnpmCalls(log), ['ARGS=--filter @metasheet/web build RANGE=true'])
})

test('explicit false builds the web app with the switch removed, not forwarded', (t) => {
  const { env, log } = scriptEnv(t, { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'false' })
  const result = runBuildScript(env)
  assert.equal(result.status, 97, result.stderr)
  assert.deepEqual(pnpmCalls(log), ['ARGS=--filter @metasheet/web build RANGE=<unset>'])
})

for (const value of ['', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'false\n']) {
  test(`rejects ${JSON.stringify(value)} before any pnpm call (install and web build)`, (t) => {
    const { env, log } = scriptEnv(t, { VITE_MULTITABLE_RANGE_FILL_ENABLED: value, INSTALL_DEPS: '1' })
    const result = runBuildScript(env)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stderr, LITERAL_ERROR)
    assert.deepEqual(pnpmCalls(log), [])
  })
}

// --- the packaged-dist assertion, run for real --------------------------------------------

function extractFunction(name) {
  const start = buildScript.indexOf(`function ${name}() {\n`)
  assert.ok(start >= 0, `${name} must exist in the build script`)
  const end = buildScript.indexOf('\n}\n', start)
  assert.ok(end > start)
  return buildScript.slice(start, end + 3)
}

function runPackagedAssertion(t, declared, distOptions) {
  const root = tmpDir(t, 'ms2-rangefill-pkg-')
  const packageRoot = path.join(root, 'pkg')
  fs.mkdirSync(path.join(packageRoot, 'apps/web'), { recursive: true })
  writeDist(path.join(packageRoot, 'apps/web'), distOptions)
  const harness = [
    'set -euo pipefail',
    'function info() { echo "[multitable-onprem-package-build] $*" >&2; }',
    'function die() { echo "[multitable-onprem-package-build] ERROR: $*" >&2; exit 1; }',
    'RANGE_FILL_IN_PACKAGED_DIST=""',
    extractFunction('assert_packaged_web_range_fill'),
    'assert_packaged_web_range_fill',
    'printf "RECORDED=%s\\n" "$RANGE_FILL_IN_PACKAGED_DIST"',
  ].join('\n')
  return spawnSync('bash', ['-c', harness], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PACKAGE_ROOT: packageRoot,
      RANGE_FILL_PROBE: probePath,
      VITE_MULTITABLE_RANGE_FILL_ENABLED: declared,
    },
  })
}

test('packaged dist: declared true + baked ON passes and records on', (t) => {
  const result = runPackagedAssertion(t, 'true', { bakedDefaults: ['"true"'] })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'RECORDED=on\n')
})

test('packaged dist: declared false + baked OFF passes and records off', (t) => {
  for (const baked of ['"false"', 'void 0']) {
    const result = runPackagedAssertion(t, 'false', { bakedDefaults: [baked] })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'RECORDED=off\n')
  }
})

for (const [label, declared, distOptions, observed] of [
  ['declared true, dist built OFF (false)', 'true', { bakedDefaults: ['"false"'] }, 'off'],
  ['declared true, dist built with the switch unset', 'true', { bakedDefaults: ['void 0'] }, 'off'],
  ['declared false, dist built ON', 'false', { bakedDefaults: ['"true"'] }, 'on'],
]) {
  test(`packaged dist: ${label} stops the build`, (t) => {
    const result = runPackagedAssertion(t, declared, distOptions)
    assert.equal(result.status, 1, result.stdout)
    assert.match(
      result.stderr,
      new RegExp(`ERROR: packaged web dist has range fill '${observed}' but VITE_MULTITABLE_RANGE_FILL_ENABLED=${declared} requires '${declared === 'true' ? 'on' : 'off'}'`),
    )
    assert.doesNotMatch(result.stdout, /RECORDED=/)
  })
}

// An unknown answer is a probe/toolchain mismatch, never a switch problem: the message must say so,
// point at the probe, and must not suggest flipping the switch (neither value would help).
for (const [label, declared, distOptions] of [
  ['declared true, shape not found', 'true', { bakedDefaults: [] }],
  ['declared false, shape not found', 'false', { bakedDefaults: [] }],
  ['declared true, two shapes', 'true', { bakedDefaults: ['"true"', '"true"'] }],
  ['declared true, no range toolbar text', 'true', { toolbar: false }],
  ['declared true, no assets at all', 'true', { assets: false }],
]) {
  test(`packaged dist: ${label} stops the build with the probe-mismatch message`, (t) => {
    const result = runPackagedAssertion(t, declared, distOptions)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /ERROR: range-fill probe cannot read the switch from the packaged web dist \(answer: unknown\)/)
    assert.match(result.stderr, /Update RANGE_FILL_TOOLBAR_TEXT \/ RANGE_FILL_BAKED_DEFAULT_SHAPE in scripts\/ops\/multitable-onprem-web-range-fill-probe\.mjs; do not change VITE_MULTITABLE_RANGE_FILL_ENABLED/)
    assert.match(result.stderr, /Reproduce locally: VITE_MULTITABLE_RANGE_FILL_ENABLED=true pnpm --filter @metasheet\/web build && node scripts\/ops\/multitable-onprem-web-range-fill-probe\.mjs apps\/web\/dist/)
    assert.doesNotMatch(result.stderr, /set VITE_MULTITABLE_RANGE_FILL_ENABLED=false|requires '(?:on|off)'/)
    assert.doesNotMatch(result.stdout, /RECORDED=/)
  })
}

test('the packaged-dist assertion runs on the staged payload, before BUILD_PROVENANCE.json is written', () => {
  const lines = buildScript.split('\n')
  const at = (exact) => {
    const index = lines.indexOf(exact)
    assert.ok(index >= 0, `missing top-level line: ${exact}`)
    return index
  }
  const prune = at('prune_node_modules "$PACKAGE_ROOT"')
  const assertCall = at('assert_packaged_web_range_fill')
  const provenanceCall = at('write_build_provenance')
  assert.ok(prune < assertCall && assertCall < provenanceCall, 'order: stage payload -> assert dist -> write provenance')
  assert.equal(lines.filter((line) => line === 'assert_packaged_web_range_fill').length, 1)
  assert.match(
    extractFunction('assert_packaged_web_range_fill'),
    /observed="\$\(node "\$RANGE_FILL_PROBE" "\$\{PACKAGE_ROOT\}\/apps\/web\/dist"\)"/,
  )
  assert.ok(buildScript.includes('RANGE_FILL_PROBE="${ROOT_DIR}/scripts/ops/multitable-onprem-web-range-fill-probe.mjs"\n'))
  const provenance = extractFunction('write_build_provenance')
  assert.ok(provenance.includes('"webBuildFlags": {\n    "VITE_MULTITABLE_RANGE_FILL_ENABLED": "${VITE_MULTITABLE_RANGE_FILL_ENABLED}",\n    "rangeFillInPackagedDist": "${RANGE_FILL_IN_PACKAGED_DIST}"\n  },'))
  // The literal check sits before the first pnpm call of the script.
  const literalCheck = buildScript.indexOf('|| die "VITE_MULTITABLE_RANGE_FILL_ENABLED must be literal true or false"')
  assert.ok(literalCheck > 0 && literalCheck < buildScript.indexOf('run pnpm install --frozen-lockfile'))
})

// --- the byte probe -----------------------------------------------------------------------

test('probe: one baked "true" with the toolbar text is on; "false" and void 0 are off', (t) => {
  const root = tmpDir(t, 'ms2-rangefill-probe-')
  assert.equal(probeRangeFill(writeDist(path.join(root, 'a'), { bakedDefaults: ['"true"'] })).state, 'on')
  assert.equal(probeRangeFill(writeDist(path.join(root, 'b'), { bakedDefaults: ['"false"'] })).state, 'off')
  assert.equal(probeRangeFill(writeDist(path.join(root, 'c'), { bakedDefaults: ['void 0'] })).state, 'off')
})

test('probe: the toolbar text alone never proves the switch is on', (t) => {
  const root = tmpDir(t, 'ms2-rangefill-probe-')
  const result = probeRangeFill(writeDist(path.join(root, 'a'), { bakedDefaults: [] }))
  assert.equal(result.state, 'unknown')
  assert.equal(result.toolbarPresent, true)
})

test('probe: unknown when the shape is ambiguous, the toolbar is missing, or there is no dist', (t) => {
  const root = tmpDir(t, 'ms2-rangefill-probe-')
  assert.equal(probeRangeFill(writeDist(path.join(root, 'a'), { bakedDefaults: ['"true"', '"true"'] })).state, 'unknown')
  assert.equal(probeRangeFill(writeDist(path.join(root, 'b'), { bakedDefaults: ['"true"'], toolbar: false })).state, 'unknown')
  assert.equal(probeRangeFill(writeDist(path.join(root, 'c'), { assets: false })).state, 'unknown')
  assert.equal(probeRangeFill(path.join(root, 'missing')).state, 'unknown')
  assert.equal(probeRangeFill('').state, 'unknown')
})

test('probe CLI prints one word and exits 2 on a usage error', (t) => {
  const root = tmpDir(t, 'ms2-rangefill-probe-')
  const on = spawnSync(process.execPath, [probePath, writeDist(path.join(root, 'a'))], { encoding: 'utf8' })
  assert.equal(on.status, 0, on.stderr)
  assert.equal(on.stdout, 'on\n')
  const unknown = spawnSync(process.execPath, [probePath, path.join(root, 'missing')], { encoding: 'utf8' })
  assert.equal(unknown.status, 0)
  assert.equal(unknown.stdout, 'unknown\n')
  const usage = spawnSync(process.execPath, [probePath], { encoding: 'utf8' })
  assert.equal(usage.status, 2)
  assert.equal(usage.stdout, '')
})

// --- the CI lanes and the other deploy routes ---------------------------------------------

function stepContaining(workflow, needle) {
  const at = workflow.indexOf(needle)
  assert.ok(at >= 0, `missing: ${needle}`)
  const start = workflow.lastIndexOf('\n      - name: ', at)
  const next = workflow.indexOf('\n      - name: ', at)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

test('every lane that packages with BUILD_WEB=0 builds its web dist with the literal true', () => {
  const dir = path.join(repoRoot, '.github/workflows')
  const lanes = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .filter((name) => readRepo(`.github/workflows/${name}`)
      .includes('BUILD_WEB=0 BUILD_BACKEND=0 scripts/ops/multitable-onprem-package-build.sh'))
    .sort()
  assert.deepEqual(lanes, [
    'multitable-onprem-package-build.yml',
    'stock-prep-main-package-verify.yml',
    'stock-prep-staging-window-rehearsal.yml',
    'stock-preparation-e2e-functional-smoke.yml',
  ])
  for (const lane of lanes) {
    const workflow = readRepo(`.github/workflows/${lane}`)
    const webStep = stepContaining(workflow, '\n          pnpm --filter @metasheet/web build\n')
    assert.match(webStep, /\n        env:\n(?:          [^\n]*\n)*?          VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true'\n/, `${lane}: web build step env`)
    const settings = workflow.match(/^\s*VITE_MULTITABLE_RANGE_FILL_ENABLED\s*[:=].*$/gm) ?? []
    assert.deepEqual(settings, ["          VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true'"], `${lane}: no other setting of the switch`)
    const packageStep = stepContaining(workflow, 'BUILD_WEB=0 BUILD_BACKEND=0 scripts/ops/multitable-onprem-package-build.sh')
    assert.ok(webStep !== packageStep && workflow.indexOf(webStep) < workflow.indexOf(packageStep), `${lane}: web build precedes packaging`)
  }
})

test('the other deploy routes keep range fill default OFF', () => {
  const dockerfile = readRepo('Dockerfile.frontend')
  assert.match(dockerfile, /^ARG VITE_MULTITABLE_RANGE_FILL_ENABLED=false$/m)
  const dingtalk = readRepo('scripts/ops/build-dingtalk-staging-images.sh')
  assert.ok(dingtalk.includes('VITE_MULTITABLE_RANGE_FILL_ENABLED="${VITE_MULTITABLE_RANGE_FILL_ENABLED-false}"\n'))
  assert.ok(buildScript.includes('VITE_MULTITABLE_RANGE_FILL_ENABLED="${VITE_MULTITABLE_RANGE_FILL_ENABLED-true}"\n'))
})

// --- source binding: the probe's assumptions, checked on every PR -------------------------
//
// The four packaging lanes are dispatched by hand and the PR-triggered smoke lane does not watch
// apps/web, so a reworded toolbar hint, a refactored switch function or a vite/esbuild upgrade
// would merge green and only fail at release time. These two tests read the real sources and run
// the real minifier, and plugin-tests.yml runs this directory on every PR.

const TOOLBAR_SOURCE = 'apps/web/src/multitable/components/MetaGridRangeToolbar.vue'
const FLAGS_SOURCE = 'apps/web/src/multitable/utils/grid-range-fill-flags.ts'

test('source binding: the toolbar hint and the switch function still carry the literals the probe reads', () => {
  const toolbar = readRepo(TOOLBAR_SOURCE)
  assert.ok(toolbar.includes(RANGE_FILL_TOOLBAR_TEXT), `${TOOLBAR_SOURCE} must contain the probe's RANGE_FILL_TOOLBAR_TEXT`)
  const flags = readRepo(FLAGS_SOURCE)
  assert.match(
    flags,
    /export function isGridRangeFillEnabled\(\n\s+value: unknown = import\.meta\.env\.VITE_MULTITABLE_RANGE_FILL_ENABLED,\n\): boolean \{\n\s+return value === 'true'\n\}/,
    `${FLAGS_SOURCE} must keep the env read as the parameter default and the exact === 'true' comparison`,
  )
})

// Resolve the esbuild that vite uses: apps/web's vite first (the one that builds the dist), else the
// root vite that the workspace overrides pin (^5.4) via vitest. No silent skip: if neither resolves
// the test fails.
function resolveViteEsbuild() {
  const anchors = [
    () => createRequire(path.join(repoRoot, 'apps/web/package.json')).resolve('vite'),
    () => {
      const vitest = createRequire(path.join(repoRoot, 'package.json')).resolve('vitest')
      return createRequire(vitest).resolve('vite')
    },
  ]
  const errors = []
  for (const anchor of anchors) {
    try {
      const vitePath = anchor()
      const esbuildPath = createRequire(vitePath).resolve('esbuild')
      return { vitePath, esbuild: createRequire(import.meta.url)(esbuildPath) }
    } catch (error) {
      errors.push(String(error && error.message ? error.message : error))
    }
  }
  assert.fail(`cannot resolve vite's esbuild from apps/web or the workspace root; run pnpm install. ${errors.join(' | ')}`)
}

// Vite 5.4 build pipeline, step for step: vite:esbuild transpiles the TS module; vite:define (an
// esbuild `define` pass) replaces import.meta.env.KEY for every KNOWN env key with its JSON value and
// the bare import.meta.env with a marker, then rewrites any remaining `<marker>.KEY` (an env key
// that was not set) to `undefined`; finally the chunk is minified by esbuild (build.minify default).
function viteLikeMinify(esbuild, source, value) {
  const env = { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true }
  if (value !== undefined) env.VITE_MULTITABLE_RANGE_FILL_ENABLED = value
  const marker = '__vite_import_meta_env__'
  const define = { 'import.meta.hot': 'undefined' }
  for (const [key, val] of Object.entries(env)) define[`import.meta.env.${key}`] = JSON.stringify(val)
  define['import.meta.env.SSR'] = 'false'
  define['import.meta.env'] = marker
  const transpiled = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'esnext' })
  let code = esbuild.transformSync(transpiled.code, { loader: 'js', format: 'esm', platform: 'neutral', define }).code
  code = code.replace(new RegExp(`${marker}\\.[\\w$]+`, 'g'), 'undefined')
  if (code.includes(marker)) code = `const ${marker} = ${JSON.stringify({ ...env, SSR: false })};\n${code}`
  return esbuild.transformSync(code, { loader: 'js', format: 'esm', target: 'es2020', minify: true }).code
}

test('source binding: vite\'s esbuild minifies the switch into exactly one probe-readable shape', (t) => {
  const { esbuild } = resolveViteEsbuild()
  assert.match(String(esbuild.version), /^0\.\d+\.\d+$/)
  const source = readRepo(FLAGS_SOURCE)
  const root = tmpDir(t, 'ms2-rangefill-esbuild-')
  for (const [label, value, expected] of [
    ['true', 'true', 'on'],
    ['false', 'false', 'off'],
    ['unset', undefined, 'off'],
  ]) {
    const code = viteLikeMinify(esbuild, source, value)
    const matches = [...code.matchAll(new RegExp(RANGE_FILL_BAKED_DEFAULT_SHAPE.source, 'g'))]
    assert.equal(matches.length, 1, `${label}: exactly one baked default in ${JSON.stringify(code)}`)
    const dist = path.join(root, label, 'dist')
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
    fs.writeFileSync(
      path.join(dist, 'assets', 'chunk.js'),
      `const hint=${JSON.stringify(RANGE_FILL_TOOLBAR_TEXT)};${code}`,
    )
    assert.equal(probeRangeFill(dist).state, expected, `${label}: probe answer for ${JSON.stringify(code)}`)
  }
})

// --- the package verifier cross-checks webBuildFlags against the dist ----------------------

const verifyScriptPath = path.join(repoRoot, 'scripts/ops/multitable-onprem-package-verify.sh')

function verifierFixture(t, { flags, rawProvenance, dist = { bakedDefaults: ['"true"'] } } = {}) {
  const root = tmpDir(t, 'ms2-rangefill-verify-')
  fs.mkdirSync(path.join(root, 'apps/web'), { recursive: true })
  writeDist(path.join(root, 'apps/web'), dist)
  const provenance = {
    schema: 'metasheet-onprem-build-provenance/v1',
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    builtAt: '2026-10-18T00:00:00Z',
    ...(flags === undefined ? {} : { webBuildFlags: flags }),
  }
  fs.writeFileSync(path.join(root, 'BUILD_PROVENANCE.json'), rawProvenance ?? `${JSON.stringify(provenance, null, 2)}\n`)
  return root
}

function runVerifier(root, { scriptDirOverride } = {}) {
  const override = scriptDirOverride === undefined ? '' : 'VERIFY_SCRIPT_DIR="$OVERRIDE_DIR"; '
  return spawnSync(
    'bash',
    ['-c', `source "$VERIFY"; ${override}verify_build_provenance "$PKG"`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, VERIFY: verifyScriptPath, PKG: root, OVERRIDE_DIR: scriptDirOverride ?? '' },
    },
  )
}

test('verifier: webBuildFlags that agree with the dist pass (on and off)', (t) => {
  const on = runVerifier(verifierFixture(t, { flags: { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true', rangeFillInPackagedDist: 'on' } }))
  assert.equal(on.status, 0, on.stderr)
  assert.match(on.stderr, /Range fill provenance OK: on/)
  const off = runVerifier(verifierFixture(t, {
    flags: { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'false', rangeFillInPackagedDist: 'off' },
    dist: { bakedDefaults: ['void 0'] },
  }))
  assert.equal(off.status, 0, off.stderr)
  assert.match(off.stderr, /Range fill provenance OK: off/)
})

test('verifier: a package that predates webBuildFlags is reported and skipped, not failed', (t) => {
  const result = runVerifier(verifierFixture(t, { dist: { bakedDefaults: ['void 0'] } }))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /no webBuildFlags .* range-fill provenance check skipped/)
})

for (const [label, fixture, message] of [
  ['recorded on, dist built OFF', { flags: { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true', rangeFillInPackagedDist: 'on' }, dist: { bakedDefaults: ['"false"'] } },
    /packaged web dist has range fill 'off' but BUILD_PROVENANCE\.json records 'on'/],
  ['recorded on, dist unreadable by the probe', { flags: { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true', rangeFillInPackagedDist: 'on' }, dist: { bakedDefaults: [] } },
    /packaged web dist has range fill 'unknown' but BUILD_PROVENANCE\.json records 'on'/],
  ['declared true but recorded off', { flags: { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true', rangeFillInPackagedDist: 'off' }, dist: { bakedDefaults: ['"false"'] } },
    /webBuildFlags disagree: VITE_MULTITABLE_RANGE_FILL_ENABLED=true but rangeFillInPackagedDist=off/],
  ['declared value not a literal', { flags: { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'TRUE', rangeFillInPackagedDist: 'on' } },
    /webBuildFlags\.VITE_MULTITABLE_RANGE_FILL_ENABLED must be literal true or false/],
  ['webBuildFlags not an object', { flags: 'true' },
    /webBuildFlags could not be read/],
]) {
  test(`verifier: ${label} fails`, (t) => {
    const result = runVerifier(verifierFixture(t, fixture))
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, message)
  })
}

test('verifier: a missing probe beside the verifier fails instead of skipping', (t) => {
  const root = verifierFixture(t, { flags: { VITE_MULTITABLE_RANGE_FILL_ENABLED: 'true', rangeFillInPackagedDist: 'on' } })
  const result = runVerifier(root, { scriptDirOverride: tmpDir(t, 'ms2-rangefill-noprobe-') })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /range-fill probe missing beside the verifier/)
})

test('the package ships the probe beside the verifier', () => {
  const requiredPaths = buildScript.match(/REQUIRED_PATHS=\(\n([\s\S]*?)\n\)/)
  assert.ok(requiredPaths)
  assert.match(requiredPaths[1], /\n {2}"scripts\/ops\/multitable-onprem-package-verify\.sh"\n/)
  assert.match(requiredPaths[1], /\n {2}"scripts\/ops\/multitable-onprem-web-range-fill-probe\.mjs"\n/)
})
