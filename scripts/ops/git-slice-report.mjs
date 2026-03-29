#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { SLICES } from './git-slices.mjs'

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

function gitSucceeds(args) {
  try {
    execFileSync('git', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
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
  return 'root'
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let json = false
  let listSlices = false
  let verify = false
  let stageCommand = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--slice':
        sliceName = argv[index + 1] ?? sliceName
        index += 1
        break
      case '--json':
        json = true
        break
      case '--list-slices':
        listSlices = true
        break
      case '--verify':
        verify = true
        break
      case '--stage-command':
        stageCommand = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { sliceName, json, listSlices, verify, stageCommand }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-report.mjs [options]

Options:
  --slice <name>       Slice name. Default: directory-migration-baseline
  --list-slices        Print available slices
  --json               Print JSON
  --verify             Exit non-zero when a slice file is missing
  --stage-command      Print the git add command for the slice
  --help, -h           Show help`)
}

function buildSliceReport(sliceName) {
  const slice = SLICES[sliceName]
  if (!slice) {
    throw new Error(`Unknown slice: ${sliceName}`)
  }

  const files = slice.files.map((filePath) => {
    const exists = existsSync(filePath)
    const tracked = exists ? gitSucceeds(['ls-files', '--error-unmatch', '--', filePath]) : false
    const status = exists ? runGit(['status', '--short', '--', filePath]) : ''
    const statusLine = status.split('\n').find(Boolean) ?? ''
    const indexStatus = statusLine[0] ?? ' '
    const worktreeStatus = statusLine[1] ?? ' '
    const untracked = indexStatus === '?' && worktreeStatus === '?'
    const changed = statusLine.length > 0

    return {
      path: filePath,
      exists,
      tracked,
      untracked,
      changed,
      status: statusLine,
      bucket: bucketForPath(filePath),
    }
  })

  const bucketCounts = Object.fromEntries(
    files.reduce((map, file) => {
      map.set(file.bucket, (map.get(file.bucket) ?? 0) + 1)
      return map
    }, new Map()).entries(),
  )

  const missing = files.filter((file) => !file.exists)
  const clean = files.filter((file) => file.exists && !file.changed)
  const trackedChanged = files.filter((file) => file.exists && file.changed && !file.untracked)
  const untracked = files.filter((file) => file.untracked)

  return {
    generatedAt: new Date().toISOString(),
    slice: sliceName,
    description: slice.description,
    totals: {
      files: files.length,
      present: files.length - missing.length,
      missing: missing.length,
      clean: clean.length,
      trackedChanged: trackedChanged.length,
      untracked: untracked.length,
    },
    buckets: bucketCounts,
    missingFiles: missing.map((file) => file.path),
    trackedChangedFiles: trackedChanged.map((file) => file.path),
    untrackedFiles: untracked.map((file) => file.path),
    cleanFiles: clean.map((file) => file.path),
    files,
    stageCommand: `git add -- ${slice.files.map(shellEscape).join(' ')}`,
    suggestedCommits: slice.suggestedCommits,
  }
}

function printHuman(report) {
  console.log('Git slice report')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  slice: ${report.slice}`)
  console.log(`  description: ${report.description}`)
  console.log(`  files: ${report.totals.files}`)
  console.log(`  present/missing: ${report.totals.present}/${report.totals.missing}`)
  console.log(`  tracked_changed: ${report.totals.trackedChanged}`)
  console.log(`  untracked: ${report.totals.untracked}`)
  console.log(`  clean: ${report.totals.clean}`)
  console.log('  buckets:')
  for (const [bucket, count] of Object.entries(report.buckets)) {
    console.log(`    - ${bucket}: ${count}`)
  }
  if (report.missingFiles.length > 0) {
    console.log('  missing_files:')
    report.missingFiles.forEach((file) => console.log(`    - ${file}`))
  }
  if (report.trackedChangedFiles.length > 0) {
    console.log('  tracked_changed_files:')
    report.trackedChangedFiles.forEach((file) => console.log(`    - ${file}`))
  }
  if (report.untrackedFiles.length > 0) {
    console.log('  untracked_files:')
    report.untrackedFiles.forEach((file) => console.log(`    - ${file}`))
  }
  console.log(`  stage_command: ${report.stageCommand}`)
  console.log('  suggested_commits:')
  report.suggestedCommits.forEach((message) => console.log(`    - ${message}`))
}

const options = parseArgs(process.argv.slice(2))

if (options.listSlices) {
  console.log(Object.keys(SLICES).join('\n'))
  process.exit(0)
}

if (!isGitWorkTree()) {
  const errorReport = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    error: 'NOT_A_GIT_REPOSITORY',
    message: 'Current working directory is not a Git working tree.',
    cwd: process.cwd(),
  }

  if (options.stageCommand) {
    console.error(errorReport.message)
  } else if (options.json) {
    console.log(JSON.stringify(errorReport, null, 2))
  } else {
    console.error('Git slice report')
    console.error(`  error: ${errorReport.error}`)
    console.error(`  message: ${errorReport.message}`)
    console.error(`  cwd: ${errorReport.cwd}`)
  }

  process.exit(2)
}

const report = buildSliceReport(options.sliceName)

if (options.stageCommand) {
  console.log(report.stageCommand)
} else if (options.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  printHuman(report)
}

if (options.verify && report.totals.missing > 0) {
  process.exit(1)
}
