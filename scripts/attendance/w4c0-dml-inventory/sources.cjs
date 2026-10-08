'use strict'

// #4556 W4C-0 Stage D — file-content sources for the DML collector.
//
// Two adapters, same shape (`readFile(relPath) -> string|null`, `listAllFiles(rootDir) ->
// relPath[]`, `listDir(relDir) -> string[]`):
//   - createWorktreeSource: reads the live working tree (used for the exact-head HEAD check).
//   - createGitRefSource: reads a pinned git ref via `git show <ref>:<path>` / `git ls-tree`
//     (used once to regenerate the pinned baseline artifact — never touches the working tree).

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function createWorktreeSource(repoRoot) {
  function readFile(relPath) {
    const abs = path.join(repoRoot, relPath)
    try {
      return fs.readFileSync(abs, 'utf8')
    } catch {
      return null
    }
  }
  function listDir(relDir) {
    const abs = path.join(repoRoot, relDir)
    try {
      return fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
  }
  function listAllFiles(rootDir) {
    const abs = path.join(repoRoot, rootDir)
    const out = []
    function walk(dirAbs, dirRel) {
      let entries
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const childAbs = path.join(dirAbs, entry.name)
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          walk(childAbs, childRel)
        } else if (entry.isFile()) {
          out.push(childRel)
        }
      }
    }
    walk(abs, rootDir)
    return out
  }
  return { readFile, listDir, listAllFiles }
}

function createGitRefSource(repoRoot, ref) {
  let treeCache = null
  function tree() {
    if (treeCache) return treeCache
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8')
    treeCache = raw.split(/\r?\n/).filter(Boolean)
    return treeCache
  }
  function readFile(relPath) {
    // Presence check via the cached tree listing avoids spawning `git show` (and its stderr
    // "fatal: path does not exist" noise) for the common case of probing package.json in
    // directories that are not workspace packages at this ref.
    if (!tree().includes(relPath)) return null
    try {
      return execFileSync('git', ['show', `${ref}:${relPath}`], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf8')
    } catch {
      return null
    }
  }
  function listDir(relDir) {
    const prefix = relDir ? `${relDir}/` : ''
    const names = new Set()
    for (const p of tree()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash > 0) names.add(rest.slice(0, slash))
    }
    return [...names]
  }
  function listAllFiles(rootDir) {
    const prefix = rootDir ? `${rootDir}/` : ''
    return tree().filter((p) => p.startsWith(prefix))
  }
  return { readFile, listDir, listAllFiles }
}

module.exports = { createWorktreeSource, createGitRefSource }
