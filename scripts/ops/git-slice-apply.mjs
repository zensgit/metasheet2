#!/usr/bin/env node

import fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { SLICES } from './git-slices.mjs'

function runGit(args, extra = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(extra.env ?? {}),
    },
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

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let groupId = null
  let json = false
  let verify = false
  let listSlices = false
  let listGroups = false
  let apply = false
  let useCurrentIndex = false
  let indexFile = null
  let exportDir = null
  let writeManifest = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--slice':
        sliceName = argv[index + 1] ?? sliceName
        index += 1
        break
      case '--group':
        groupId = argv[index + 1] ?? groupId
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
      case '--list-groups':
        listGroups = true
        break
      case '--apply':
        apply = true
        break
      case '--use-current-index':
        useCurrentIndex = true
        break
      case '--index-file':
        indexFile = argv[index + 1] ?? indexFile
        index += 1
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

  if (useCurrentIndex && !apply) {
    throw Object.assign(new Error('Use --use-current-index only together with --apply.'), {
      code: 'CURRENT_INDEX_REQUIRES_APPLY',
      exitCode: 1,
    })
  }

  if (useCurrentIndex && !groupId) {
    throw Object.assign(new Error('Applying to the current index requires a single --group.'), {
      code: 'CURRENT_INDEX_REQUIRES_GROUP',
      exitCode: 1,
    })
  }

  return {
    sliceName,
    groupId,
    json,
    verify,
    listSlices,
    listGroups,
    apply,
    useCurrentIndex,
    indexFile,
    exportDir,
    writeManifest,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-apply.mjs [options]

Options:
  --slice <name>           Slice name. Default: directory-migration-baseline
  --group <id>             Restrict to one commit group
  --list-slices            Print available slices
  --list-groups            Print groups for the selected slice
  --json                   Print JSON
  --verify                 Exit non-zero when a selected group cannot be staged safely
  --apply                  Persist the staged result to the target index
  --use-current-index      Apply directly to the live repo index. Requires --apply and --group
  --index-file <path>      Alternate index path. Default: temporary index
  --export-dir <path>      Write per-group staged patch files and a manifest
  --write-manifest <path>  Write manifest JSON to the given path
  --help, -h               Show help`)
}

function createTempIndexFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'git-slice-apply-'))
  return {
    dir,
    indexFile: path.join(dir, 'index'),
  }
}

async function stageGroup(group, options) {
  const indexMode = options.useCurrentIndex ? 'current-index' : 'alternate-index'
  const tempIndex = !options.useCurrentIndex && !options.indexFile ? createTempIndexFile() : null
  const resolvedIndexFile = options.useCurrentIndex
    ? null
    : path.resolve(options.indexFile ?? tempIndex.indexFile)
  const env = resolvedIndexFile ? { GIT_INDEX_FILE: resolvedIndexFile } : {}

  const missingFiles = []
  for (const file of group.files) {
    try {
      await fs.access(path.resolve(file))
    } catch {
      missingFiles.push(file)
    }
  }
  if (missingFiles.length > 0) {
    throw Object.assign(
      new Error(
        `Commit group ${group.id} contains missing files: ${missingFiles.join(', ')}`,
      ),
      {
        code: 'MISSING_GROUP_FILES',
        exitCode: 1,
      },
    )
  }

  if (resolvedIndexFile) {
    await fs.mkdir(path.dirname(resolvedIndexFile), { recursive: true })
    runGit(['read-tree', 'HEAD'], { env })
  }

  runGit(['add', '--', ...group.files], { env })

  const stagedFiles = runGit(['diff', '--cached', '--name-only'], { env })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  const patch = runGit(['diff', '--cached', '--binary'], { env })
  const treeHash = runGit(['write-tree'], { env })

  const result = {
    id: group.id,
    message: group.message,
    indexMode,
    indexFile: resolvedIndexFile,
    ephemeralIndex: Boolean(tempIndex),
    stagedFiles,
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    patchEmpty: patch.length === 0,
    hasStagedChanges: stagedFiles.length > 0 && patch.length > 0,
    treeHash,
    stageCommand: `git add -- ${group.files.map(shellEscape).join(' ')}`,
  }

  if (options.exportDir) {
    const exportDir = path.resolve(options.exportDir)
    await fs.mkdir(exportDir, { recursive: true })
    const patchPath = path.join(exportDir, `${group.id}.staged.patch`)
    await fs.writeFile(patchPath, patch, 'utf8')
    result.patchPath = patchPath
  }

  if (tempIndex && !options.apply && !options.indexFile) {
    await fs.rm(tempIndex.dir, { recursive: true, force: true })
    result.indexFile = null
  }

  return result
}

async function buildApplyReport(options) {
  const slice = ensureSlice(options.sliceName)
  const selectedGroups = options.groupId
    ? [ensureGroup(slice, options.groupId)]
    : slice.commitGroups
  const groupResults = []

  for (const group of selectedGroups) {
    groupResults.push(await stageGroup(group, options))
  }

  return {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    description: slice.description,
    selectedGroupsCount: selectedGroups.length,
    applyMode: options.useCurrentIndex
      ? 'current-index'
      : options.apply
        ? 'alternate-index-persisted'
        : 'alternate-index-dry-run',
    verifyPassed: groupResults.every((group) => group.hasStagedChanges),
    groups: groupResults,
  }
}

async function writeManifest(report, manifestPath) {
  const resolvedPath = path.resolve(manifestPath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return resolvedPath
}

function printHuman(report) {
  console.log('Git slice apply')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  slice: ${report.slice}`)
  console.log(`  description: ${report.description}`)
  console.log(`  apply_mode: ${report.applyMode}`)
  console.log(`  verify_passed: ${report.verifyPassed ? 'yes' : 'no'}`)
  console.log('  groups:')
  report.groups.forEach((group) => {
    console.log(`    - ${group.id}: ${group.message}`)
    console.log(`      index_mode=${group.indexMode}`)
    if (group.indexFile) {
      console.log(`      index_file=${group.indexFile}`)
    }
    console.log(`      staged_files=${group.stagedFiles.length}`)
    console.log(`      patch_bytes=${group.patchBytes}`)
    console.log(`      patch_empty=${group.patchEmpty ? 'yes' : 'no'}`)
    console.log(`      has_staged_changes=${group.hasStagedChanges ? 'yes' : 'no'}`)
    console.log(`      tree_hash=${group.treeHash}`)
    console.log(`      stage_command=${group.stageCommand}`)
    if (group.patchPath) {
      console.log(`      patch_path=${group.patchPath}`)
    }
  })
}

function printError(error, options) {
  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    error: error.code ?? 'GIT_SLICE_APPLY_ERROR',
    message: error.message,
    cwd: process.cwd(),
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error('Git slice apply')
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
  const slice = ensureSlice(options.sliceName)

  if (options.listGroups) {
    console.log(slice.commitGroups.map((group) => group.id).join('\n'))
    process.exit(0)
  }

  const report = await buildApplyReport(options)

  if (options.writeManifest) {
    report.manifestPath = await writeManifest(report, options.writeManifest)
  }

  if (options.exportDir) {
    const exportManifestPath = path.join(path.resolve(options.exportDir), 'apply-manifest.json')
    report.exportManifestPath = await writeManifest(report, exportManifestPath)
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHuman(report)
  }

  if (options.verify && !report.verifyPassed) {
    process.exit(1)
  }
} catch (error) {
  printError(error, options)
}
