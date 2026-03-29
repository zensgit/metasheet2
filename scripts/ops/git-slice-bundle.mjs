#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
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

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
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

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let json = false
  let verify = false
  let listSlices = false
  let groupId = null
  let stageCommand = false
  let exportDir = null
  let writeManifest = null

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
      case '--verify':
        verify = true
        break
      case '--list-slices':
        listSlices = true
        break
      case '--group':
        groupId = argv[index + 1] ?? groupId
        index += 1
        break
      case '--stage-command':
        stageCommand = true
        break
      case '--export-dir':
        exportDir = argv[index + 1] ?? exportDir
        index += 1
        break
      case '--write-manifest':
        writeManifest = argv[index + 1] ?? writeManifest
        index += 1
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw Object.assign(new Error(`Unknown argument: ${arg}`), {
          code: 'UNKNOWN_ARGUMENT',
          exitCode: 1,
        })
    }
  }

  return {
    sliceName,
    json,
    verify,
    listSlices,
    groupId,
    stageCommand,
    exportDir,
    writeManifest,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-bundle.mjs [options]

Options:
  --slice <name>          Slice name. Default: directory-migration-baseline
  --list-slices           Print available slices
  --group <id>            Restrict stage/export output to one commit group
  --json                  Print JSON
  --verify                Exit non-zero when the bundle definition is invalid
  --stage-command         Print git add commands for the commit groups
  --export-dir <path>     Write manifest and per-group patch files
  --write-manifest <path> Write manifest JSON to the given path
  --help, -h              Show help`)
}

function ensureSlice(sliceName) {
  const slice = SLICES[sliceName]
  if (!slice) {
    throw Object.assign(new Error(`Unknown slice: ${sliceName}`), {
      code: 'UNKNOWN_SLICE',
      exitCode: 1,
    })
  }
  if (!Array.isArray(slice.commitGroups) || slice.commitGroups.length === 0) {
    throw Object.assign(new Error(`Slice ${sliceName} does not define commit groups.`), {
      code: 'MISSING_COMMIT_GROUPS',
      exitCode: 1,
    })
  }
  return slice
}

function ensureGroup(slice, groupId) {
  const group = slice.commitGroups.find((entry) => entry.id === groupId)
  if (!group) {
    throw Object.assign(new Error(`Unknown commit group: ${groupId}`), {
      code: 'UNKNOWN_COMMIT_GROUP',
      exitCode: 1,
    })
  }
  return group
}

function inspectFile(filePath) {
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
    changed,
    untracked,
    clean: exists && !changed,
    status: statusLine,
    bucket: bucketForPath(filePath),
  }
}

function summarizeFiles(files) {
  const missing = files.filter((file) => !file.exists).map((file) => file.path)
  const trackedChanged = files
    .filter((file) => file.exists && file.changed && !file.untracked)
    .map((file) => file.path)
  const untracked = files.filter((file) => file.untracked).map((file) => file.path)
  const clean = files.filter((file) => file.clean).map((file) => file.path)

  return {
    totals: {
      files: files.length,
      missing: missing.length,
      trackedChanged: trackedChanged.length,
      untracked: untracked.length,
      clean: clean.length,
    },
    missing,
    trackedChanged,
    untracked,
    clean,
  }
}

function buildSliceCoverage(slice) {
  const sliceFiles = uniqueSorted(slice.files)
  const fileCounts = new Map()

  for (const group of slice.commitGroups) {
    for (const filePath of group.files) {
      fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1)
    }
  }

  const assigned = uniqueSorted([...fileCounts.keys()])
  const duplicates = [...fileCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([filePath, count]) => ({ path: filePath, count }))
  const unassigned = sliceFiles.filter((filePath) => !fileCounts.has(filePath))
  const extra = assigned.filter((filePath) => !sliceFiles.includes(filePath))

  return {
    sliceFiles,
    assigned,
    duplicates,
    unassigned,
    extra,
    complete: duplicates.length === 0 && unassigned.length === 0 && extra.length === 0,
  }
}

function buildManifest(sliceName) {
  const slice = ensureSlice(sliceName)
  const coverage = buildSliceCoverage(slice)
  const groups = slice.commitGroups.map((group) => {
    const files = group.files.map(inspectFile)
    const summary = summarizeFiles(files)
    return {
      id: group.id,
      message: group.message,
      description: group.description ?? null,
      stageCommand: `git add -- ${group.files.map(shellEscape).join(' ')}`,
      files,
      totals: summary.totals,
      missingFiles: summary.missing,
      trackedChangedFiles: summary.trackedChanged,
      untrackedFiles: summary.untracked,
      cleanFiles: summary.clean,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    slice: sliceName,
    description: slice.description,
    filesCount: coverage.sliceFiles.length,
    coverage: {
      complete: coverage.complete,
      duplicateAssignments: coverage.duplicates,
      unassignedFiles: coverage.unassigned,
      extraFiles: coverage.extra,
    },
    groups,
    verifyPassed: coverage.complete && groups.every((group) => group.totals.missing === 0),
  }
}

async function writeManifestFile(manifest, manifestPath) {
  const resolvedPath = path.resolve(manifestPath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return resolvedPath
}

async function writePatchFiles(manifest, exportDir, selectedGroupId) {
  const resolvedDir = path.resolve(exportDir)
  await fs.mkdir(resolvedDir, { recursive: true })

  const selectedGroups = selectedGroupId
    ? manifest.groups.filter((group) => group.id === selectedGroupId)
    : manifest.groups

  const patches = []
  for (const group of selectedGroups) {
    const patchOutput = runGit(['diff', '--binary', '--no-ext-diff', '--', ...group.files.map((file) => file.path)])
    const patchPath = path.join(resolvedDir, `${group.id}.patch`)
    await fs.writeFile(patchPath, patchOutput, 'utf8')
    patches.push({
      id: group.id,
      path: patchPath,
      bytes: Buffer.byteLength(patchOutput, 'utf8'),
      empty: patchOutput.length === 0,
    })
  }

  const manifestPath = path.join(resolvedDir, 'manifest.json')
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return {
    exportDir: resolvedDir,
    manifestPath,
    patches,
  }
}

function printHuman(manifest) {
  console.log('Git slice bundle')
  console.log(`  generated_at: ${manifest.generatedAt}`)
  console.log(`  slice: ${manifest.slice}`)
  console.log(`  description: ${manifest.description}`)
  console.log(`  files: ${manifest.filesCount}`)
  console.log(`  verify_passed: ${manifest.verifyPassed ? 'yes' : 'no'}`)
  console.log(`  coverage_complete: ${manifest.coverage.complete ? 'yes' : 'no'}`)
  if (manifest.coverage.duplicateAssignments.length > 0) {
    console.log('  duplicate_assignments:')
    manifest.coverage.duplicateAssignments.forEach((entry) => {
      console.log(`    - ${entry.path} (${entry.count})`)
    })
  }
  if (manifest.coverage.unassignedFiles.length > 0) {
    console.log('  unassigned_files:')
    manifest.coverage.unassignedFiles.forEach((filePath) => console.log(`    - ${filePath}`))
  }
  if (manifest.coverage.extraFiles.length > 0) {
    console.log('  extra_files:')
    manifest.coverage.extraFiles.forEach((filePath) => console.log(`    - ${filePath}`))
  }
  console.log('  groups:')
  manifest.groups.forEach((group) => {
    console.log(`    - ${group.id}: ${group.message}`)
    console.log(`      files=${group.totals.files} tracked_changed=${group.totals.trackedChanged} untracked=${group.totals.untracked} missing=${group.totals.missing}`)
    console.log(`      stage_command=${group.stageCommand}`)
  })
}

function printError(error, options) {
  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    error: error.code ?? 'GIT_SLICE_BUNDLE_ERROR',
    message: error.message,
    cwd: process.cwd(),
  }

  if (options.stageCommand) {
    console.error(report.message)
  } else if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error('Git slice bundle')
    console.error(`  error: ${report.error}`)
    console.error(`  message: ${report.message}`)
    console.error(`  cwd: ${report.cwd}`)
  }

  process.exit(error.exitCode ?? 1)
}

let options

try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  printError(error, {
    sliceName: 'directory-migration-baseline',
    json: process.argv.includes('--json'),
    stageCommand: process.argv.includes('--stage-command'),
  })
}

if (options.listSlices) {
  console.log(Object.keys(SLICES).join('\n'))
  process.exit(0)
}

if (!isGitWorkTree()) {
  printError(
    Object.assign(new Error('Current working directory is not a Git working tree.'), {
      code: 'NOT_A_GIT_REPOSITORY',
      exitCode: 2,
    }),
    options,
  )
}

try {
  const manifest = buildManifest(options.sliceName)
  const selectedGroup = options.groupId ? ensureGroup(ensureSlice(options.sliceName), options.groupId) : null

  if (options.writeManifest) {
    manifest.manifestPath = await writeManifestFile(manifest, options.writeManifest)
  }

  if (options.exportDir) {
    manifest.export = await writePatchFiles(manifest, options.exportDir, options.groupId)
  }

  if (options.stageCommand) {
    const groups = selectedGroup
      ? manifest.groups.filter((group) => group.id === selectedGroup.id)
      : manifest.groups
    const output = groups
      .map((group) => `# ${group.id}\n${group.stageCommand}`)
      .join('\n')
    console.log(output)
  } else if (options.json) {
    console.log(JSON.stringify(manifest, null, 2))
  } else {
    printHuman(manifest)
  }

  if (options.verify && !manifest.verifyPassed) {
    process.exit(1)
  }
} catch (error) {
  printError(error, options)
}
