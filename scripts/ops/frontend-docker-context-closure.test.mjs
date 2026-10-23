import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Dockerfile.frontend builds apps/web from a context of COPY instructions, not the whole repo.
// #6315 shipped a panel importing plugins/plugin-integration-core/lib modules; the PR lanes build
// the web app from a full checkout, so only the push-to-main image build saw the missing files.
// This pins the closure: every file apps/web/src reaches through a relative import, and every
// file those reach in turn (plus their declaration siblings), must be copied into the builder
// stage, at its own path, before the web build runs.

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.vue', '.json']
const DECLARATION_SIBLINGS = { '.mjs': ['.d.mts'], '.js': ['.d.ts'], '.cjs': ['.d.cts'] }
const WEB_BUILD = /pnpm\s+--filter\s+@metasheet\/web\s+build/

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
  const candidates = [base, ...SOURCE_EXTENSIONS.map(ext => base + ext), ...SOURCE_EXTENSIONS.map(ext => path.join(base, 'index' + ext))]
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
    if (!pending && (!line || line.startsWith('#'))) continue
    if (line.endsWith('\\')) { pending += line.slice(0, -1) + ' '; continue }
    instructions.push((pending + line).trim())
    pending = ''
  }
  const stageStarts = instructions.map((text, index) => (/^FROM\s/i.test(text) ? index : -1)).filter(index => index >= 0)
  const stage = instructions.slice(stageStarts[0] + 1, stageStarts[1] ?? instructions.length)
  const copies = []
  let webBuildIndex = -1
  stage.forEach((text, index) => {
    if (/^COPY\s/i.test(text)) {
      const tokens = text.split(/\s+/).slice(1)
      if (tokens.some(token => token.startsWith('--from='))) return
      const args = tokens.filter(token => !token.startsWith('--'))
      copies.push({ index, sources: args.slice(0, -1), dest: args[args.length - 1] })
    } else if (/^RUN\s/i.test(text) && WEB_BUILD.test(text) && webBuildIndex < 0) {
      webBuildIndex = index
    }
  })
  return { copies, webBuildIndex }
}

const norm = value => path.posix.normalize(value.replace(/^\.\//, '')).replace(/\/$/, '')

// A repo-relative file lands at the same path under WORKDIR /app if some COPY before the web build
// copies it (or a directory holding it) to that same path.
export function isCopiedAtOwnPath(rel, stage) {
  return stage.copies.some(copy => {
    if (stage.webBuildIndex >= 0 && copy.index > stage.webBuildIndex) return false
    const dest = copy.dest
    return copy.sources.some(source => {
      const src = norm(source)
      if (rel === src) return copy.sources.length === 1 && !dest.endsWith('/') ? norm(dest) === rel : norm(dest) + '/' + path.posix.basename(rel) === rel
      return rel.startsWith(src + '/') && copy.sources.length === 1 && norm(dest) === src
    })
  })
}

// Files outside the directory COPYs that apps/web/src reaches, transitively, with declaration siblings.
export function collectUncoveredReach(root, webSrc, stage) {
  const reached = new Set()
  const queue = walk(webSrc)
  const seen = new Set(queue)
  while (queue.length) {
    const file = queue.shift()
    let source
    try { source = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const specifier of extractRelativeSpecifiers(source)) {
      const target = resolveRelative(file, specifier)
      if (!target) continue
      const rel = toPosix(path.relative(root, target))
      const isDirectoryCovered = stage.copies.some(copy => copy.sources.length === 1 && rel.startsWith(norm(copy.sources[0]) + '/') && norm(copy.dest) === norm(copy.sources[0]))
      if (isDirectoryCovered) continue
      const additions = [target, ...(DECLARATION_SIBLINGS[path.extname(target)] ?? []).map(ext => target.slice(0, -path.extname(target).length) + ext).filter(sibling => fs.existsSync(sibling))]
      for (const addition of additions) {
        reached.add(toPosix(path.relative(root, addition)))
        if (!seen.has(addition)) { seen.add(addition); queue.push(addition) }
      }
    }
  }
  return [...reached].sort()
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

test('builder-stage parsing: directory copies, file-to-directory copies, order and --from', () => {
  const stage = parseBuilderStage([
    'FROM node:20-slim AS builder',
    'COPY package.json ./',
    'COPY apps ./apps',
    'RUN pnpm install --frozen-lockfile',
    '# comment',
    'COPY plugins/p/lib/a.mjs \\',
    '  plugins/p/lib/a.d.mts ./plugins/p/lib/',
    'COPY plugins/p/lib/wrong.mjs ./elsewhere/',
    'RUN pnpm --filter @metasheet/web build',
    'COPY plugins/p/lib/late.mjs ./plugins/p/lib/',
    'FROM nginx:alpine',
    'COPY --from=builder /app/apps/web/dist /usr/share/nginx/html',
    'COPY plugins/p/lib/runtime.mjs ./plugins/p/lib/',
  ].join('\r\n'))
  assert.ok(isCopiedAtOwnPath('apps/web/src/main.ts', stage))
  assert.ok(isCopiedAtOwnPath('plugins/p/lib/a.mjs', stage))
  assert.ok(isCopiedAtOwnPath('plugins/p/lib/a.d.mts', stage))
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/wrong.mjs', stage), false, 'copied, but not at its own path')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/late.mjs', stage), false, 'copied only after the web build')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/runtime.mjs', stage), false, 'copied only in the runtime stage')
  assert.equal(isCopiedAtOwnPath('plugins/p/lib/missing.mjs', stage), false)
})

test('reach collection follows imports out of the context, transitively, with declaration siblings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-docker-context-'))
  try {
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
    write('apps/web/src/components/Panel.vue', "<script setup lang=\"ts\">\nimport { a } from '../../../../plugins/p/lib/a.mjs'\nimport { u } from '../util'\n</script>\n")
    write('apps/web/src/util.ts', "export const u = 1\n")
    write('plugins/p/lib/a.mjs', "import { b } from './b.mjs'\nexport const a = b\n")
    write('plugins/p/lib/a.d.mts', "export declare const a: number\n")
    write('plugins/p/lib/b.mjs', "export const b = 1\n")
    write('plugins/p/lib/unrelated.mjs', "export const z = 1\n")
    const stage = parseBuilderStage('FROM node AS builder\nCOPY apps ./apps\nRUN pnpm --filter @metasheet/web build\n')
    assert.deepEqual(collectUncoveredReach(root, path.join(root, 'apps/web/src'), stage), ['plugins/p/lib/a.d.mts', 'plugins/p/lib/a.mjs', 'plugins/p/lib/b.mjs'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Dockerfile.frontend copies everything apps/web/src reaches, at its own path, before the web build', () => {
  const stage = parseBuilderStage(fs.readFileSync(path.join(repo, 'Dockerfile.frontend'), 'utf8'))
  assert.ok(stage.webBuildIndex >= 0, 'the builder stage must run the @metasheet/web build')
  assert.ok(isCopiedAtOwnPath('apps/web/package.json', stage), 'apps/ must be in the build context')
  const reached = collectUncoveredReach(repo, path.join(repo, 'apps/web/src'), stage)
  const missing = reached.filter(rel => !isCopiedAtOwnPath(rel, stage))
  assert.deepEqual(missing, [], `Dockerfile.frontend must COPY these into the builder stage before the web build: ${missing.join(', ')}`)
})
