import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isCopiedAtOwnPath, parseBuilderStage } from './frontend-docker-context-closure.test.mjs'

// Every tarball pnpm-lock.yaml resolves must come from the repository, not from a remote host.
// The SheetJS xlsx 0.20.3 tarball (official channel, #3737 D3-a) used to be fetched from the
// vendor CDN on every cold install; on 2026-10-28 that host kept answering ECONNRESET: the main
// image build (run 40647340591) hung in "Build backend" until the 6 h job timeout and
// "Tasks real DB" (run 40647340779) failed at pnpm install before any test ran. The same bytes now
// live at vendor/xlsx-0.20.3.tgz and resolve through `file:`; pnpm still checks them against the
// lockfile sha512 and fails closed on any other bytes.
//
// The PR lanes install from a full checkout, so they cannot see an install context that lacks
// vendor/: the Docker image build runs only on push to main, and the on-prem package is installed
// on the customer host. This pins the closure instead:
//   1. every `tarball:` the lockfile resolves is a `file:` path inside the repo;
//   2. that file exists and its sha512 equals the lockfile integrity (no pnpm run needed);
//   3. Dockerfile.backend and Dockerfile.frontend each copy it, at its own path, before their one
//      builder-stage `RUN pnpm install` (COPY semantics come from the #6511 guard's parser);
//   4. both on-prem package builders list it (or a parent directory) in REQUIRED_PATHS.
// Not modelled (each needs its own rule here first): git or directory resolutions, registry
// tarballs given without a `tarball:` key (those come from the configured registry), ADD or
// RUN --mount instead of COPY, an install chained into another RUN, installs outside the builder
// stage, .dockerignore files (refused, as #6511 does), and the package verifiers' own required lists.

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DOCKERFILES = ['Dockerfile.backend', 'Dockerfile.frontend']
const BUILDERS = ['scripts/ops/multitable-onprem-package-build.sh', 'scripts/ops/attendance-onprem-package-build.sh']
const PNPM_INSTALL_LIKE = /\bpnpm\s+(?:install|i|add|fetch)\b/
const PNPM_INSTALL_RUN = /^RUN\s+pnpm\s+install\b/

const lines = text => text.replace(/\r/g, '').split('\n')

// [{ tarball, integrity, line }] for every lockfile line that names a tarball.
export function lockfileTarballs(lockText) {
  const entries = []
  lines(lockText).forEach((text, index) => {
    if (!/\btarball:/.test(text)) return
    const tarball = text.match(/\btarball:\s*([^,}\s]+)/)?.[1] ?? null
    const integrity = /^\s*resolution:\s*\{.*\}\s*$/.test(text) ? (text.match(/\bintegrity:\s*([^,}\s]+)/)?.[1] ?? null) : null
    entries.push({ tarball, integrity, line: index + 1 })
  })
  return entries
}

function sha512Integrity(file) {
  return 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}

function requiredPaths(script) {
  const block = script.replace(/\r/g, '').match(/\nREQUIRED_PATHS=\(\n([\s\S]*?)\n\)/)
  return block ? [...block[1].matchAll(/^  "([^"]+)"$/gm)].map(match => match[1]) : null
}

// Problems that would make a fresh `pnpm install --frozen-lockfile` need a remote tarball host, or
// fail in an install context that does not carry the vendored file. Empty means closed.
export function checkVendoredInstallClosure(root, { lockfile = 'pnpm-lock.yaml', dockerfiles = DOCKERFILES, builders = BUILDERS } = {}) {
  const problems = []
  const vendored = []
  for (const entry of lockfileTarballs(fs.readFileSync(path.join(root, lockfile), 'utf8'))) {
    const where = `${lockfile}:${entry.line}`
    if (!entry.tarball || !entry.integrity) { problems.push(`${where}: tarball line is not an inline resolution with an integrity; teach this guard the shape`); continue }
    if (!entry.tarball.startsWith('file:')) {
      problems.push(`${where}: tarball ${entry.tarball} is fetched from a remote host; vendor the exact bytes under vendor/ and resolve them with file: (#3737 P3)`)
      continue
    }
    const rel = path.posix.normalize(entry.tarball.slice('file:'.length))
    if (path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) { problems.push(`${where}: ${entry.tarball} points outside the repository`); continue }
    vendored.push(rel)
    const file = path.join(root, rel)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { problems.push(`${rel}: missing; pnpm-lock.yaml resolves it at ${where}`); continue }
    if (!entry.integrity.startsWith('sha512-')) { problems.push(`${where}: integrity of ${rel} is not sha512`); continue }
    if (sha512Integrity(file) !== entry.integrity) problems.push(`${rel}: sha512 does not match the pnpm-lock.yaml integrity at ${where}`)
  }

  for (const name of dockerfiles) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) { problems.push(`${name}: missing`); continue }
    const text = lines(fs.readFileSync(file, 'utf8'))
    for (const ignoreFile of ['.dockerignore', `${name}.dockerignore`]) {
      if (fs.existsSync(path.join(root, ignoreFile))) problems.push(`${ignoreFile} filters the ${name} build context; teach this guard its patterns before adding one`)
    }
    const froms = text.map((line, index) => (/^FROM\s/i.test(line.trim()) ? index : -1)).filter(index => index >= 0)
    const installs = text.map((line, index) => (!line.trim().startsWith('#') && PNPM_INSTALL_LIKE.test(line) ? index : -1)).filter(index => index >= 0)
    const install = installs[0]
    if (installs.length !== 1 || !PNPM_INSTALL_RUN.test(text[install].trim()) || text[install].trim().endsWith('\\')
      || !(install > froms[0]) || (froms.length > 1 && install > froms[1])) {
      problems.push(`${name}: expected exactly one single-line builder-stage \`RUN pnpm install ...\` (found ${installs.length} pnpm install-like line(s)); teach this guard the new shape`)
      continue
    }
    const full = parseBuilderStage(text.join('\n'))
    if (full.workdirs.length !== 1 || full.workdirs[0].dir !== '/app' || !full.copies.every(copy => copy.index > full.workdirs[0].index)) {
      problems.push(`${name}: COPY destinations are read relative to a single builder-stage WORKDIR /app that precedes every COPY`)
      continue
    }
    // Only what the builder stage has copied when the install runs counts.
    const beforeInstall = parseBuilderStage(text.slice(0, install).join('\n'))
    for (const rel of vendored) {
      if (!isCopiedAtOwnPath(rel, beforeInstall)) problems.push(`${name}: ${rel} is not copied, at its own path, before \`RUN pnpm install\` (add e.g. \`COPY vendor ./vendor\` above it)`)
    }
  }

  for (const name of builders) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) { problems.push(`${name}: missing`); continue }
    const payload = requiredPaths(fs.readFileSync(file, 'utf8'))
    if (!payload) { problems.push(`${name}: no REQUIRED_PATHS=( ... ) array found`); continue }
    for (const rel of vendored) {
      if (!payload.some(entry => rel === entry || rel.startsWith(entry + '/'))) problems.push(`${name}: REQUIRED_PATHS does not list ${rel}; the package's frozen install would fail on the customer host`)
    }
  }
  return { vendored, problems }
}

test('fixture: a closed tree passes, and each open shape is named', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-tarball-closure-'))
  try {
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
    write('vendor/pkg-1.0.0.tgz', Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x0d, 0x0a]))
    const integrity = sha512Integrity(path.join(root, 'vendor/pkg-1.0.0.tgz'))
    const lock = tarball => [
      "lockfileVersion: '9.0'",
      'packages:',
      '  left-pad@1.3.0:',
      '    resolution: {integrity: sha512-registryonly==}',
      `  pkg@${tarball}:`,
      `    resolution: {integrity: ${integrity}, tarball: ${tarball}}`,
      '    version: 1.0.0',
      '',
    ].join('\n')
    const docker = (...body) => ['FROM node:20-slim AS builder', 'WORKDIR /app', 'COPY package.json pnpm-lock.yaml ./', ...body, 'FROM nginx AS runner', 'COPY --from=builder /app/dist ./dist', ''].join('\r\n')
    const builder = (...entries) => ['#!/usr/bin/env bash', 'REQUIRED_PATHS=(', '  "package.json"', ...entries.map(entry => `  "${entry}"`), ')', ''].join('\n')
    const options = { dockerfiles: ['Dockerfile.a'], builders: ['build.sh'] }
    const check = () => checkVendoredInstallClosure(root, options).problems

    write('pnpm-lock.yaml', lock('file:vendor/pkg-1.0.0.tgz'))
    write('Dockerfile.a', docker('COPY vendor ./vendor', 'RUN pnpm install --frozen-lockfile', 'RUN pnpm build'))
    write('build.sh', builder('vendor/pkg-1.0.0.tgz'))
    assert.deepEqual(checkVendoredInstallClosure(root, options), { vendored: ['vendor/pkg-1.0.0.tgz'], problems: [] })
    write('build.sh', builder('vendor'))
    assert.deepEqual(check(), [], 'a parent directory in REQUIRED_PATHS covers the file')
    write('Dockerfile.a', docker('COPY vendor/pkg-1.0.0.tgz ./vendor/', 'RUN pnpm install --frozen-lockfile'))
    assert.deepEqual(check(), [], 'a file COPY into its own directory covers the file')

    write('Dockerfile.a', docker('RUN pnpm install --frozen-lockfile', 'COPY vendor ./vendor'))
    assert.match(check().join('\n'), /Dockerfile\.a: vendor\/pkg-1\.0\.0\.tgz is not copied/, 'a COPY after the install covers nothing')
    write('Dockerfile.a', docker('RUN pnpm install --frozen-lockfile'))
    assert.match(check().join('\n'), /Dockerfile\.a: vendor\/pkg-1\.0\.0\.tgz is not copied/, 'no COPY at all')
    write('Dockerfile.a', docker('COPY vendor ./third_party', 'RUN pnpm install --frozen-lockfile'))
    assert.match(check().join('\n'), /Dockerfile\.a: vendor\/pkg-1\.0\.0\.tgz is not copied/, 'copied, but not at its own path')
    write('Dockerfile.a', docker('COPY vendor ./vendor', 'RUN corepack enable && pnpm install --frozen-lockfile'))
    assert.match(check().join('\n'), /Dockerfile\.a: expected exactly one single-line builder-stage/, 'an install chained into another RUN is refused')
    write('Dockerfile.a', docker('COPY vendor ./vendor', 'RUN pnpm install --frozen-lockfile', 'RUN pnpm install --prod'))
    assert.match(check().join('\n'), /found 2 pnpm install-like/, 'a second install is refused')
    write('Dockerfile.a', docker('COPY vendor ./vendor', 'RUN pnpm install \\', '  --frozen-lockfile'))
    assert.match(check().join('\n'), /expected exactly one single-line/, 'a continued install line is refused')
    write('Dockerfile.a', docker('COPY vendor ./vendor', 'WORKDIR /srv', 'RUN pnpm install --frozen-lockfile'))
    assert.match(check().join('\n'), /single builder-stage WORKDIR \/app/, 'a second WORKDIR is refused')
    write('Dockerfile.a', docker('COPY vendor ./vendor', 'RUN pnpm install --frozen-lockfile'))
    write('.dockerignore', 'vendor\n')
    assert.match(check().join('\n'), /\.dockerignore filters the Dockerfile\.a build context/)
    fs.rmSync(path.join(root, '.dockerignore'))

    write('build.sh', builder('pnpm-lock.yaml'))
    assert.match(check().join('\n'), /build\.sh: REQUIRED_PATHS does not list vendor\/pkg-1\.0\.0\.tgz/)
    write('build.sh', builder('vendor/pkg-1.0.0.tgz'))

    write('pnpm-lock.yaml', lock('https://cdn.example.invalid/pkg-1.0.0.tgz'))
    assert.match(check().join('\n'), /pnpm-lock\.yaml:6: tarball https:\/\/cdn\.example\.invalid\/pkg-1\.0\.0\.tgz is fetched from a remote host/)
    write('pnpm-lock.yaml', lock('file:vendor/missing-1.0.0.tgz'))
    assert.match(check().join('\n'), /vendor\/missing-1\.0\.0\.tgz: missing/)
    write('pnpm-lock.yaml', lock('file:../outside.tgz'))
    assert.match(check().join('\n'), /points outside the repository/)
    write('pnpm-lock.yaml', lock('file:vendor/pkg-1.0.0.tgz').replace(`integrity: ${integrity}, `, ''))
    assert.match(check().join('\n'), /not an inline resolution with an integrity/)
    write('pnpm-lock.yaml', lock('file:vendor/pkg-1.0.0.tgz'))
    fs.appendFileSync(path.join(root, 'vendor/pkg-1.0.0.tgz'), 'x')
    assert.match(check().join('\n'), /vendor\/pkg-1\.0\.0\.tgz: sha512 does not match the pnpm-lock\.yaml integrity/, 'one appended byte is caught')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real repo: every lockfile tarball is vendored with its pinned bytes and reaches every install context', () => {
  const { vendored, problems } = checkVendoredInstallClosure(repo)
  assert.deepEqual(problems, [], problems.join('\n'))
  // Fails if the lockfile parse silently found nothing, so the guard cannot pass vacuously.
  assert.ok(vendored.length >= 1, 'expected at least one file: tarball in pnpm-lock.yaml (vendor/xlsx-0.20.3.tgz)')
})
