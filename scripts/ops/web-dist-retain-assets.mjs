#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Publishers use this on a private staging directory, before replacing live files.
// Assets accumulate deliberately: age alone cannot prove that old tabs are closed.
function statOrMissing(file) {
  try { return fs.lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function safeRoot(input) {
  // A shell resolves symlink/../ physically, while path.resolve collapses it
  // lexically. Never validate one tree and let the publisher copy another.
  if (input.split(/[\\/]+/).includes('..')) throw new Error('Parent traversal in web dist path is refused')
  const absolute = path.resolve(input)
  if (absolute === path.parse(absolute).root) throw new Error('Refusing filesystem root as web dist')
  let current = absolute
  let canonical
  const missing = []
  while (true) {
    const stat = statOrMissing(current)
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error(`Symbolic link/reparse path refused: ${current}`)
      if (!stat.isDirectory()) throw new Error(`Expected directory: ${current}`)
      if (!canonical) canonical = path.join(fs.realpathSync.native(current), ...missing.reverse())
    } else if (!canonical) missing.push(path.basename(current))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return canonical
}

function key(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file
}

function disjoint(left, right) {
  const a = key(left), b = key(right)
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
    throw new Error('Web dist paths overlap; source and target must be separate directories')
  }
}

function inspect(root, required) {
  const entries = new Map()
  const stat = statOrMissing(root)
  if (!stat) {
    if (required) throw new Error(`Missing prepared web dist: ${root}`)
    return entries
  }
  function visit(relative) {
    const absolute = path.join(root, relative)
    const info = fs.lstatSync(absolute)
    if (info.isSymbolicLink()) throw new Error(`Symbolic link/reparse entry refused: ${absolute}`)
    if (!info.isDirectory() && !info.isFile()) throw new Error(`Non-regular web dist entry: ${absolute}`)
    const type = info.isDirectory() ? 'directory' : 'file'
    entries.set(key(relative), { relative, absolute, type })
    if (type === 'directory') {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name))
    }
  }
  visit('')
  return entries
}

function plan(sourceInput, previousInput) {
  const source = safeRoot(sourceInput), previous = safeRoot(previousInput)
  disjoint(source, previous)
  const nextEntries = inspect(source, true)
  if (nextEntries.get(key('index.html'))?.type !== 'file') throw new Error('Missing source index.html')
  const oldEntries = inspect(previous, false)
  const assetsKey = key('assets')
  for (const entries of [nextEntries, oldEntries]) {
    if (entries.has(assetsKey) && entries.get(assetsKey).type !== 'directory') {
      throw new Error('Web dist assets must be a directory')
    }
  }
  const additions = []
  for (const [name, old] of oldEntries) {
    if (name !== assetsKey && !name.startsWith(assetsKey + path.sep)) continue
    const next = nextEntries.get(name)
    if (next) {
      if (old.type !== next.type || (old.type === 'file' && !fs.readFileSync(old.absolute).equals(fs.readFileSync(next.absolute)))) {
        throw new Error(`Immutable asset collision: ${old.relative}`)
      }
    } else additions.push(old)
  }
  return { source, previous, additions }
}

export function validateWebDist(source, previous) {
  plan(source, previous)
}

export function retainWebDistAssets(previous, prepared) {
  const { source, additions } = plan(prepared, previous)
  // Every collision and input path is checked before the first staging write.
  for (const item of additions) {
    const destination = path.join(source, item.relative)
    if (item.type === 'directory') fs.mkdirSync(destination, { recursive: true })
    else fs.copyFileSync(item.absolute, destination, fs.constants.COPYFILE_EXCL)
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, first, second, ...extra] = process.argv.slice(2)
    if (!first || !second || extra.length || !['validate', 'retain'].includes(command)) {
      throw new Error('Usage: web-dist-retain-assets.mjs validate <source> <previous> | retain <previous> <prepared>')
    }
    if (command === 'validate') validateWebDist(first, second)
    else retainWebDistAssets(first, second)
  } catch (error) {
    console.error(`[web-dist-retain-assets] ${error.message}`)
    process.exitCode = 1
  }
}
