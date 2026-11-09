import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Dockerfile.frontend builds apps/web from a context of COPY instructions, not the whole repo.
// #6315 shipped a panel importing plugins/plugin-integration-core/lib modules; the PR lanes build
// the web app from a full checkout, so only the push-to-main image build saw the missing files.
// This pins the closure: apps/web/src and vite.config.ts, every file they reach through a relative
// import, and every file those reach in turn (plus their declaration siblings), must be copied into
// the builder stage, at its own path, before the web build runs. Files and directories get one
// coverage rule, so a directory COPY after the build counts for nothing, and the walk does not stop
// at a file the context copies: its own imports can still leave the context. A relative import the
// walk cannot resolve stays in as a path, so it fails closed unless a pre-build COPY covers it.
// Not modelled (each needs its own rule here first): bare workspace-package imports, Vite-only
// references (import.meta.glob, new URL(), SFC src=, CSS url()), template-literal import() and
// triple-slash paths, and RUN steps that delete copied files. The real-repo test refuses shapes the
// coverage rule cannot read: an ignore file, a WORKDIR other than one /app, or a second build RUN.

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.vue', '.json']
const DECLARATION_SIBLINGS = { '.mjs': ['.d.mts'], '.js': ['.d.ts'], '.cjs': ['.d.cts'] }
// TypeScript resolves './x.js' to x.ts or x.d.ts (and .mjs / .cjs likewise) when x.js does not exist.
const TS_SUBSTITUTES = { '.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] }
const WEB_BUILD = /pnpm\s+--filter\s+@metasheet\/web\s+build/
// COPY flags that do not change which files land where; any other (--parents, --exclude, ...) covers nothing.
const PLAIN_COPY_FLAG = /^--(?:chown|chmod)=|^--link(?:=true)?$/

export function extractRelativeSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1].replace(/[?#].*$/, ''))
  }
  return [...specifiers]
}

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const ext = path.extname(base)
  const candidates = [
    base,
    ...(TS_SUBSTITUTES[ext] ?? []).map(substitute => base.slice(0, -ext.length) + substitute),
    ...[...SOURCE_EXTENSIONS, '.d.ts', '.d.mts'].map(extension => base + extension),
    ...SOURCE_EXTENSIONS.map(extension => path.join(base, 'index' + extension)),
  ]
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null
}

function walk(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name)) || entry.name.endsWith('.d.ts')) files.push(full)
  }
  return files
}

function toPosix(rel) {
  return rel.split(path.sep).join('/')
}

// Dockerfile instructions of the first (builder) stage, with line continuations joined.
export function parseBuilderStage(dockerfile) {
  const instructions = []
  let pending = ''
  for (const raw of dockerfile.replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    // Like BuildKit, drop comment and blank lines even inside a continuation.
    if (!line || line.startsWith('#')) continue
    if (line.endsWith('\\')) { pending += line.slice(0, -1) + ' '; continue }
    instructions.push((pending + line).trim())
    pending = ''
  }
  const stageStarts = instructions.map((text, index) => (/^FROM\s/i.test(text) ? index : -1)).filter(index => index >= 0)
  const stage = instructions.slice(stageStarts[0] + 1, stageStarts[1] ?? instructions.length)
  const copies = []
  const workdirs = []
  const webBuilds = []
  stage.forEach((text, index) => {
    if (/^COPY\s/i.test(text)) {
      const tokens = text.split(/\s+/).slice(1)
      if (tokens.some(token => token.startsWith('--from='))) return
      const args = tokens.filter(token => !token.startsWith('--'))
      copies.push({ index, flags: tokens.filter(token => token.startsWith('--')), sources: args.slice(0, -1), dest: args[args.length - 1] })
    } else if (/^WORKDIR\s/i.test(text)) {
      workdirs.push({ index, dir: text.split(/\s+/)[1] })
    } else if (/^RUN\s/i.test(text) && WEB_BUILD.test(text)) {
      webBuilds.push(index)
    }
  })
  return { copies, workdirs, webBuilds, webBuildIndex: webBuilds.length ? webBuilds[0] : -1 }
}

const norm = value => path.posix.normalize(value.replace(/^\.\//, '')).replace(/\/$/, '')

// A repo-relative file lands at the same path under WORKDIR /app if some plain COPY before the web
// build copies it (or a directory holding it) to that same path. Docker reads a destination as a
// directory only with a trailing slash (or `.`): several files sent to `./dir` land as one file `dir`.
export function isCopiedAtOwnPath(rel, stage) {
  return stage.copies.some(copy => {
    if (stage.webBuildIndex >= 0 && copy.index > stage.webBuildIndex) return false
    if (!copy.flags.every(flag => PLAIN_COPY_FLAG.test(flag))) return false
    const dest = norm(copy.dest)
    const intoDirectory = copy.dest.endsWith('/') || dest === '.'
    return copy.sources.some(source => {
      const src = norm(source)
      if (rel === src) return intoDirectory ? (dest === '.' ? '' : dest + '/') + path.posix.basename(rel) === rel : copy.sources.length === 1 && dest === rel
      return rel.startsWith(src + '/') && copy.sources.length === 1 && dest === src
    })
  })
}

// Every file the web build needs: apps/web/src and vite.config.ts (vue-tsc -b checks it through
// tsconfig.node.json, vite build loads it) plus what they reach through relative imports,
// transitively (copied files included), with declaration siblings and unresolved edges as paths.
export function collectReach(root, webSrc) {
  const queue = [...walk(webSrc), ...['vite.config.ts'].map(name => path.join(path.dirname(webSrc), name)).filter(file => fs.existsSync(file))]
  const seen = new Set(queue)
  while (queue.length) {
    const file = queue.shift()
    let source
    try { source = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const specifier of extractRelativeSpecifiers(source)) {
      const target = resolveRelative(file, specifier)
      if (!target) { seen.add(path.resolve(path.dirname(file), specifier)); continue }
      const ext = path.extname(target)
      const siblings = (DECLARATION_SIBLINGS[ext] ?? []).map(sibling => target.slice(0, -ext.length) + sibling).filter(sibling => fs.existsSync(sibling))
      for (const addition of [target, ...siblings]) {
        if (!seen.has(addition)) { seen.add(addition); queue.push(addition) }
      }
    }
  }
  return [...seen].map(file => toPosix(path.relative(root, file))).sort()
}

// The files the web build needs that the builder stage does not copy, at their own path, before it runs.
export function missingFromBuilderStage(root, webSrc, stage) {
  return collectReach(root, webSrc).filter(rel => !isCopiedAtOwnPath(rel, stage))
}

test('relative specifier extraction covers static, side-effect, dynamic and require forms', () => {
  const found = extractRelativeSpecifiers([
    "import { a } from '../a.mjs'",
    "import type { B } from './b'",
    "export { c } from '../../c.js'",
    "import './side.css?inline'",
    "const d = await import('./d.mjs')",
    "const e = require('../e.cjs')",
    "import vue from 'vue'",
    "import x from '@/x'",
  ].join('\n'))
  assert.deepEqual(found.sort(), ['../../c.js', '../a.mjs', '../e.cjs', './b', './d.mjs', './side.css'].sort())
})

test('builder-stage parsing: directory and file copies, trailing slashes, flags, order and --from', () => {
  const stage = parseBuilderStage([
    'FROM node:20-slim AS builder',
    'WORKDIR /app',
    'COPY package.json ./',
    'COPY apps ./apps',
    'RUN pnpm install --frozen-lockfile',
    '# comment',
    'COPY plugins/p/lib/a.mjs \\',
    '  # a comment inside a continuation does not end the instruction',
    '  plugins/p/lib/a.d.mts ./plugins/p/lib/',
    'COPY plugins/p/lib/x.mjs plugins/p/lib/y.mjs ./plugins/p/lib',
    'COPY --chown=node:node --link plugins/p/lib/owned.mjs ./plugins/p/lib/',
    'COPY --parents plugins/p/lib/nested.mjs ./plugins/p/lib/',
    'COPY plugins/p/lib/wrong.mjs ./elsewhere/',
    'RUN pnpm --filter @metasheet/web build',
    'COPY plugins/p/lib/late.mjs ./plugins/p/lib/',
    'FROM nginx:alpine',
    'COPY --from=builder /app/apps/web/dist /usr/share/nginx/html',
    'COPY plugins/p/lib/runtime.mjs ./plugins/p/lib/',
  ].join('\r\n'))
  assert.deepEqual(stage.workdirs.map(workdir => workdir.dir), ['/app'])
  assert.equal(stage.webBuilds.length, 1)
  assert.ok(isCopiedAtOwnPath('package.json', stage), 'a root file copied to ./')
  assert.ok(isCopiedAtOwnPath('apps/web/src/main.ts', stage))
  assert.ok(isCopiedAtOwnPath('plugins/p/lib/a.mjs', stage))
  assert.ok(isCopiedAtOwnPath('plugins/p/lib/a.d.mts', stage))
  assert.ok(isCopiedAtOwnPath('plugins/p/lib/owned.mjs', stage), '--chown and --link do not move files')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/x.mjs', stage), false, 'several files sent to a destination without a trailing slash land as one file')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/y.mjs', stage), false, 'several files sent to a destination without a trailing slash land as one file')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/nested.mjs', stage), false, '--parents nests the file under the destination')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/wrong.mjs', stage), false, 'copied, but not at its own path')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/late.mjs', stage), false, 'copied only after the web build')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/runtime.mjs', stage), false, 'copied only in the runtime stage')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/missing.mjs', stage), false)
})

test('missing files: imports leave the context transitively, through copied files, and only pre-build COPYs count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-docker-context-'))
  try {
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
    write('apps/web/src/components/Panel.vue', [
      '<script setup lang="ts">',
      "import { a } from '../../../../plugins/p/lib/a.mjs'",
      "import { c } from '../../../../packages/shared/bridge'",
      "import { t } from '../../../../plugins/p/lib/typed.js'",
      "import { g } from '../../../../plugins/p/lib/ghost.mjs'",
      "import { u } from '../util'",
      '</script>',
    ].join('\n'))
    write('apps/web/src/util.ts', "export const u = 1\n")
    write('apps/web/vite.config.ts', "import { helper } from '../../plugins/p/lib/config-helper.mjs'\nexport default helper\n")
    write('packages/shared/bridge.ts', "export { c } from '../../plugins/p/lib/c.mjs'\n")
    write('plugins/p/lib/a.mjs', "import { b } from './b.mjs'\nexport const a = b\n")
    write('plugins/p/lib/a.d.mts', "export declare const a: number\n")
    write('plugins/p/lib/b.mjs', "export const b = 1\n")
    write('plugins/p/lib/c.mjs', "export const c = 1\n")
    write('plugins/p/lib/config-helper.mjs', "export const helper = {}\n")
    write('plugins/p/lib/typed.ts', "export const t = 1\n")
    write('plugins/p/lib/unrelated.mjs', "export const z = 1\n")
    const webSrc = path.join(root, 'apps/web/src')
    const reach = collectReach(root, webSrc)
    // c.mjs is reached only through packages/shared/bridge.ts, which the context does copy; config-helper.mjs
    // only through vite.config.ts; typed.js resolves to typed.ts as TypeScript would; ghost.mjs resolves to nothing.
    const plugin = ['plugins/p/lib/a.d.mts', 'plugins/p/lib/a.mjs', 'plugins/p/lib/b.mjs', 'plugins/p/lib/c.mjs', 'plugins/p/lib/config-helper.mjs', 'plugins/p/lib/ghost.mjs', 'plugins/p/lib/typed.ts']
    assert.deepEqual(reach, ['apps/web/src/components/Panel.vue', 'apps/web/src/util.ts', 'apps/web/vite.config.ts', 'packages/shared/bridge.ts', ...plugin])
    const build = 'RUN pnpm --filter @metasheet/web build'
    const missing = (...instructions) => missingFromBuilderStage(root, webSrc, parseBuilderStage(['FROM node AS builder', ...instructions].join('\n')))
    const context = ['COPY apps ./apps', 'COPY packages ./packages']
    const listed = 'plugins/p/lib/a.mjs plugins/p/lib/a.d.mts plugins/p/lib/b.mjs plugins/p/lib/c.mjs plugins/p/lib/config-helper.mjs plugins/p/lib/typed.ts'
    assert.deepEqual(missing(...context, build), plugin)
    assert.deepEqual(missing(...context, build, 'COPY plugins ./plugins'), plugin, 'a directory COPY after the web build covers nothing')
    assert.deepEqual(missing(...context, 'COPY plugins ./vendor/plugins', build), plugin, 'a directory copied to another path covers nothing')
    assert.deepEqual(missing(build, ...context, 'COPY plugins ./plugins'), reach, 'with every COPY after the web build, nothing is copied')
    assert.deepEqual(missing(...context, `COPY ${listed} ./plugins/p/lib`, build), plugin, 'listed files sent to a destination without a trailing slash land as one file')
    assert.deepEqual(missing(...context, `COPY ${listed} ./plugins/p/lib/`, build), ['plugins/p/lib/ghost.mjs'], 'an import the walk cannot resolve fails closed')
    assert.deepEqual(missing(...context, 'COPY plugins/p/lib ./plugins/p/lib', build), [])
    assert.deepEqual(missing(...context, 'COPY plugins ./plugins', build), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Dockerfile.frontend copies everything the web build reaches, at its own path, before the web build', () => {
  const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile.frontend'), 'utf8')
  const stage = parseBuilderStage(dockerfile)
  // Shapes the coverage rule cannot read fail here instead of passing unchecked.
  for (const ignoreFile of ['.dockerignore', 'Dockerfile.frontend.dockerignore']) {
    assert.equal(fs.existsSync(path.join(repo, ignoreFile)), false, `${ignoreFile} filters the build context; teach this guard its patterns before adding one`)
  }
  assert.deepEqual(stage.workdirs.map(workdir => workdir.dir), ['/app'], 'COPY destinations are read relative to a single WORKDIR /app')
  assert.ok(stage.copies.every(copy => copy.index > stage.workdirs[0].index), 'WORKDIR /app must come before every COPY')
  assert.equal(stage.webBuilds.length, 1, 'exactly one builder-stage RUN may build @metasheet/web')
  assert.ok(isCopiedAtOwnPath('apps/web/package.json', stage), 'apps/ must be in the build context')
  const webSrc = path.join(repo, 'apps/web/src')
  const missing = missingFromBuilderStage(repo, webSrc, stage)
  assert.deepEqual(missing, [], `Dockerfile.frontend must COPY these into the builder stage before the web build: ${missing.join(', ')}`)
  // The same path on the real graph: hoist the web build above every COPY and everything must go missing.
  const lines = dockerfile.replace(/\r/g, '').split('\n')
  const from = lines.findIndex(line => /^FROM\s/i.test(line.trim()))
  const run = lines.findIndex(line => WEB_BUILD.test(line))
  const hoisted = [...lines.slice(0, from + 1), lines[run], ...lines.filter((_, index) => index > from && index !== run)].join('\n')
  assert.deepEqual(missingFromBuilderStage(repo, webSrc, parseBuilderStage(hoisted)), collectReach(repo, webSrc))
})
