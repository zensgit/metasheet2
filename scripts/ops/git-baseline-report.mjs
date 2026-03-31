#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function runGit(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}

function isGitWorkTree() {
  try {
    return runGit(['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

function bucketForPath(filePath) {
  if (filePath.startsWith('apps/')) return 'apps'
  if (filePath.startsWith('packages/')) return 'packages'
  if (filePath.startsWith('docs/')) return 'docs'
  if (filePath.startsWith('scripts/')) return 'scripts'
  if (filePath.startsWith('docker/')) return 'docker'
  if (filePath.startsWith('plugins/')) return 'plugins'
  if (filePath.startsWith('output/')) return 'output'
  if (filePath.startsWith('.github/')) return 'github'
  if (filePath.startsWith('.claude/')) return 'claude'
  return 'root'
}

function summarizeBuckets(files) {
  const buckets = new Map()
  for (const file of files) {
    const bucket = bucketForPath(file)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  return Object.fromEntries([...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function normalizeStatusPath(rawValue) {
  const trimmed = rawValue.trim()
  if (trimmed.includes(' -> ')) {
    return trimmed.split(' -> ').at(-1)?.trim() ?? trimmed
  }
  return trimmed
}

function parseStatusLine(line) {
  return {
    raw: line,
    indexStatus: line[0] ?? ' ',
    worktreeStatus: line[1] ?? ' ',
    filePath: normalizeStatusPath(line.slice(3)),
  }
}

function resolveUpstream() {
  try {
    const upstream = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    return upstream || null
  } catch {
    return null
  }
}

function parseArgs(argv) {
  let json = false

  for (const arg of argv) {
    switch (arg) {
      case '--json':
        json = true
        break
      case '--help':
      case '-h':
        console.log(`Usage: node scripts/ops/git-baseline-report.mjs [--json]`)
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { json }
}

const options = parseArgs(process.argv.slice(2))

if (!isGitWorkTree()) {
  const payload = {
    generatedAt: new Date().toISOString(),
    error: 'NOT_A_GIT_REPOSITORY',
    message: 'Current working directory is not a Git working tree.',
    cwd: process.cwd(),
  }
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.error('Git baseline report')
    console.error(`  error: ${payload.error}`)
    console.error(`  message: ${payload.message}`)
    console.error(`  cwd: ${payload.cwd}`)
  }
  process.exit(2)
}

const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
const upstream = resolveUpstream()
const head = runGit(['rev-parse', 'HEAD'])
const ahead = upstream ? Number(runGit(['rev-list', '--count', `${upstream}..HEAD`])) : 0
const behind = upstream ? Number(runGit(['rev-list', '--count', `HEAD..${upstream}`])) : 0
const dirtyLines = runGit(['status', '--short', '--untracked-files=all']).split('\n').filter(Boolean)
const dirtyEntries = dirtyLines.map(parseStatusLine)
const dirtyPaths = [...new Set(dirtyEntries.map((entry) => entry.filePath))].sort((a, b) => a.localeCompare(b))

const payload = {
  generatedAt: new Date().toISOString(),
  branch,
  upstream,
  head,
  ahead,
  behind,
  dirty: dirtyPaths.length > 0,
  changedFileCount: dirtyPaths.length,
  modifiedTrackedCount: dirtyEntries.filter((entry) => entry.indexStatus !== '?' || entry.worktreeStatus !== '?').length,
  untrackedCount: dirtyEntries.filter((entry) => entry.indexStatus === '?' && entry.worktreeStatus === '?').length,
  dirtyBuckets: summarizeBuckets(dirtyPaths),
  samplePaths: dirtyPaths.slice(0, 20),
}

if (options.json) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log('Git baseline report')
  console.log(`  generated_at: ${payload.generatedAt}`)
  console.log(`  branch: ${payload.branch}`)
  console.log(`  upstream: ${payload.upstream ?? 'none'}`)
  console.log(`  head: ${payload.head}`)
  console.log(`  ahead: ${payload.ahead}`)
  console.log(`  behind: ${payload.behind}`)
  console.log(`  dirty: ${payload.dirty}`)
  console.log(`  changed_file_count: ${payload.changedFileCount}`)
  console.log(`  modified_tracked_count: ${payload.modifiedTrackedCount}`)
  console.log(`  untracked_count: ${payload.untrackedCount}`)
  console.log(`  dirty_buckets: ${Object.entries(payload.dirtyBuckets).map(([bucket, count]) => `${bucket}=${count}`).join(', ')}`)
  console.log('  sample_paths:')
  for (const filePath of payload.samplePaths) {
    console.log(`    - ${filePath}`)
  }
}
