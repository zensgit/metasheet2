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

function parseBranchHeader(headerLine) {
  const line = headerLine.replace(/^##\s+/, '')
  const [branchPart, trackingPart] = line.split('...')
  const branch = branchPart.trim()
  let upstream = null
  let ahead = 0
  let behind = 0

  if (trackingPart) {
    const match = trackingPart.match(/^([^\[]+)(?:\s+\[(.+)\])?$/)
    upstream = match?.[1]?.trim() ?? null
    const counters = match?.[2] ?? ''
    const aheadMatch = counters.match(/ahead\s+(\d+)/)
    const behindMatch = counters.match(/behind\s+(\d+)/)
    ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0
    behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0
  }

  return { branch, upstream, ahead, behind }
}

function bucketForPath(filePath) {
  if (!filePath) return 'unknown'
  const normalized = filePath.replace(/^[^A-Za-z0-9._-]+\s*/, '')
  if (normalized.startsWith('apps/')) return 'apps'
  if (normalized.startsWith('packages/')) return 'packages'
  if (normalized.startsWith('docs/')) return 'docs'
  if (normalized.startsWith('scripts/')) return 'scripts'
  if (normalized.startsWith('docker/')) return 'docker'
  if (normalized.startsWith('plugins/')) return 'plugins'
  return 'root'
}

function parseStatusLine(line) {
  const indexStatus = line[0] ?? ' '
  const worktreeStatus = line[1] ?? ' '
  const filePath = line.slice(3).trim()
  return {
    raw: line,
    indexStatus,
    worktreeStatus,
    filePath,
    bucket: bucketForPath(filePath),
    untracked: indexStatus === '?' && worktreeStatus === '?',
  }
}

function buildReport() {
  const statusOutput = runGit(['status', '--short', '--branch'])
  const lines = statusOutput.split('\n').filter(Boolean)
  const header = parseBranchHeader(lines[0] ?? '## unknown')
  const files = lines.slice(1).map(parseStatusLine)

  const bucketSummary = new Map()
  for (const file of files) {
    bucketSummary.set(file.bucket, (bucketSummary.get(file.bucket) ?? 0) + 1)
  }

  const modifiedTracked = files.filter((file) => !file.untracked).length
  const untracked = files.filter((file) => file.untracked).length
  const bucketCounts = Object.fromEntries(
    [...bucketSummary.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  )

  const suggestions = []
  if (header.behind > 0) {
    suggestions.push('先处理分支落后远端的问题，再做基线收口。')
  }
  if (header.ahead > 0) {
    suggestions.push('将本地领先提交整理成可复查的基线提交序列。')
  }
  if (files.length > 0) {
    suggestions.push('清理 dirty worktree，至少把目录同步相关改动分组固化。')
  }

  return {
    generatedAt: new Date().toISOString(),
    branch: header.branch,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    dirty: files.length > 0,
    changedFileCount: files.length,
    modifiedTrackedCount: modifiedTracked,
    untrackedCount: untracked,
    bucketCounts,
    sampleFiles: files.slice(0, 20).map((file) => ({
      path: file.filePath,
      indexStatus: file.indexStatus,
      worktreeStatus: file.worktreeStatus,
      bucket: file.bucket,
    })),
    suggestions,
  }
}

function printHuman(report) {
  console.log('Git baseline report')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  branch: ${report.branch}`)
  console.log(`  upstream: ${report.upstream ?? '-'}`)
  console.log(`  ahead/behind: ${report.ahead}/${report.behind}`)
  console.log(`  dirty: ${report.dirty ? 'yes' : 'no'}`)
  console.log(`  changed_files: ${report.changedFileCount}`)
  console.log(`  modified_tracked: ${report.modifiedTrackedCount}`)
  console.log(`  untracked: ${report.untrackedCount}`)
  console.log('  buckets:')
  for (const [bucket, count] of Object.entries(report.bucketCounts)) {
    console.log(`    - ${bucket}: ${count}`)
  }
  if (report.sampleFiles.length > 0) {
    console.log('  sample_files:')
    report.sampleFiles.forEach((file) => {
      console.log(`    - [${file.indexStatus}${file.worktreeStatus}] ${file.path} (${file.bucket})`)
    })
  }
  if (report.suggestions.length > 0) {
    console.log('  suggestions:')
    report.suggestions.forEach((item) => console.log(`    - ${item}`))
  }
}

const json = process.argv.includes('--json')

if (!isGitWorkTree()) {
  const errorReport = {
    generatedAt: new Date().toISOString(),
    error: 'NOT_A_GIT_REPOSITORY',
    message: 'Current working directory is not a Git working tree.',
    cwd: process.cwd(),
  }

  if (json) {
    console.log(JSON.stringify(errorReport, null, 2))
  } else {
    console.error('Git baseline report')
    console.error(`  error: ${errorReport.error}`)
    console.error(`  message: ${errorReport.message}`)
    console.error(`  cwd: ${errorReport.cwd}`)
  }

  process.exit(2)
}

const report = buildReport()

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  printHuman(report)
}
