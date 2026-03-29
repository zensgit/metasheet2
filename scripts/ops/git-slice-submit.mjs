#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { SLICES } from './git-slices.mjs'

function runGit(args, extra = {}) {
  return execFileSync('git', args, {
    cwd: extra.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(extra.env ?? {}),
    },
  }).trimEnd()
}

function gitSucceeds(args, extra = {}) {
  try {
    execFileSync('git', args, {
      cwd: extra.cwd ?? process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        ...(extra.env ?? {}),
      },
    })
    return true
  } catch {
    return false
  }
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

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let promoteManifest = null
  let handoffManifest = null
  let replayManifest = null
  let attestManifest = null
  let outputDir = null
  let writeManifest = null
  let json = false
  let verify = false
  let listSlices = false
  let listGroups = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--slice':
        sliceName = argv[index + 1] ?? sliceName
        index += 1
        break
      case '--promote-manifest':
        promoteManifest = argv[index + 1] ?? promoteManifest
        index += 1
        break
      case '--handoff-manifest':
        handoffManifest = argv[index + 1] ?? handoffManifest
        index += 1
        break
      case '--replay-manifest':
        replayManifest = argv[index + 1] ?? replayManifest
        index += 1
        break
      case '--attest-manifest':
        attestManifest = argv[index + 1] ?? attestManifest
        index += 1
        break
      case '--output-dir':
        outputDir = argv[index + 1] ?? outputDir
        index += 1
        break
      case '--write-manifest':
        writeManifest = argv[index + 1] ?? writeManifest
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

  if (
    !listSlices &&
    !listGroups &&
    (!promoteManifest || !handoffManifest || !replayManifest || !attestManifest)
  ) {
    const missing = []
    if (!promoteManifest) {
      missing.push('--promote-manifest')
    }
    if (!handoffManifest) {
      missing.push('--handoff-manifest')
    }
    if (!replayManifest) {
      missing.push('--replay-manifest')
    }
    if (!attestManifest) {
      missing.push('--attest-manifest')
    }
    throw Object.assign(
      new Error(`Provide ${missing.join(', ')} for git-slice-submit.`),
      {
        code: 'MANIFESTS_REQUIRED',
        exitCode: 1,
      },
    )
  }

  return {
    sliceName,
    promoteManifest,
    handoffManifest,
    replayManifest,
    attestManifest,
    outputDir,
    writeManifest,
    json,
    verify,
    listSlices,
    listGroups,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-submit.mjs [options]

Options:
  --slice <name>             Slice name. Default: directory-migration-baseline
  --promote-manifest <path>  Promote manifest path
  --handoff-manifest <path>  Handoff manifest path
  --replay-manifest <path>   Replay manifest path
  --attest-manifest <path>   Attest manifest path
  --output-dir <path>        Write submit packet and summary files
  --write-manifest <path>    Write manifest JSON to the given path
  --verify                   Mark this submit packet as verify mode
  --list-slices              Print available slices
  --list-groups              Print groups for the selected slice
  --json                     Print JSON
  --help, -h                 Show help`)
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

async function writeTextFile(filePath, contents, executable = false) {
  const resolvedPath = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, contents, 'utf8')
  if (executable) {
    await fs.chmod(resolvedPath, 0o755)
  }
  return resolvedPath
}

async function writeJsonFile(filePath, payload) {
  return writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

async function loadManifest(filePath, label, sliceName) {
  const resolvedPath = path.resolve(filePath)
  const raw = await fs.readFile(resolvedPath, 'utf8')
  const data = JSON.parse(raw)
  if (data.slice && data.slice !== sliceName) {
    throw Object.assign(
      new Error(`Manifest slice mismatch in ${label}: expected ${sliceName}, got ${data.slice}.`),
      {
        code: 'MANIFEST_SLICE_MISMATCH',
        exitCode: 1,
        label,
        manifestPath: resolvedPath,
      },
    )
  }
  return {
    label,
    path: resolvedPath,
    data,
  }
}

function unique(values) {
  return [...new Set(values)]
}

function assertSingleValue(label, values, code) {
  const distinct = unique(values.filter((value) => value !== null && value !== undefined && value !== ''))
  if (distinct.length !== 1) {
    throw Object.assign(new Error(`${label} mismatch: ${distinct.join(', ')}`), {
      code,
      exitCode: 1,
      values: distinct,
    })
  }
  return distinct[0]
}

function normalizePromoteManifest(manifest) {
  return {
    label: manifest.label,
    manifestPath: manifest.path,
    baseRef: manifest.data.baseRef ?? null,
    baseSha: manifest.data.baseSha ?? null,
    branchName: manifest.data.branchName ?? null,
    head: manifest.data.head ?? null,
    verifyPassed: Boolean(manifest.data.verifyPassed),
    commitCount: manifest.data.commitCount ?? 0,
    sliceFilesCount: manifest.data.sliceFilesCount ?? 0,
    groups: (manifest.data.groups ?? []).map((group) => ({
      order: group.order,
      id: group.id,
      message: group.message,
      sourceCommitSha: group.sourceCommitSha ?? null,
      promotedCommitSha: group.promotedCommitSha ?? null,
      patchPath: group.patchPath ?? null,
      patchBytes: group.patchBytes ?? null,
      committedFiles: group.committedFiles ?? [],
    })),
  }
}

function normalizeHandoffManifest(manifest) {
  return {
    label: manifest.label,
    manifestPath: manifest.path,
    baseRef: manifest.data.baseRef ?? null,
    baseSha: manifest.data.baseSha ?? null,
    sourceBranch: manifest.data.sourceBranch ?? null,
    sourceHead: manifest.data.sourceHead ?? null,
    verifyPassed: Boolean(manifest.data.verifyPassed),
    commitCount: manifest.data.commitCount ?? 0,
    bundleSha256: manifest.data.bundleSha256 ?? null,
    bundlePath: manifest.data.bundlePath ?? null,
    groups: (manifest.data.groups ?? []).map((group) => ({
      order: group.order,
      id: group.id,
      message: group.message,
      patchFileName: group.patchFileName ?? null,
      patchSha256: group.patchSha256 ?? null,
      patchId: group.patchId ?? null,
    })),
  }
}

function normalizeReplayManifest(manifest) {
  return {
    label: manifest.label,
    manifestPath: manifest.path,
    baseRef: manifest.data.baseRef ?? null,
    baseSha: manifest.data.baseSha ?? null,
    sourceBranch: manifest.data.sourceBranch ?? null,
    sourceHead: manifest.data.sourceHead ?? null,
    replayedHead: manifest.data.replayedHead ?? null,
    replayBranchName: manifest.data.replayBranchName ?? null,
    verifyPassed: Boolean(manifest.data.verifyPassed),
    commitCount: manifest.data.commitCount ?? 0,
    bundleSha256: manifest.data.bundleSha256 ?? null,
    groups: (manifest.data.groups ?? []).map((group) => ({
      order: group.order,
      id: group.id,
      message: group.message,
      patchFileName: group.patchFileName ?? null,
      patchSha256: group.patchSha256 ?? null,
      replayedCommitSha: group.replayedCommitSha ?? null,
      sourceCommitSha: group.sourceCommitSha ?? null,
    })),
  }
}

function normalizeAttestManifest(manifest) {
  return {
    label: manifest.label,
    manifestPath: manifest.path,
    baseRef: manifest.data.baseRef ?? null,
    baseSha: manifest.data.baseSha ?? null,
    verifyPassed: Boolean(manifest.data.verifyPassed),
    commitCount: manifest.data.commitCount ?? 0,
    invariants: manifest.data.invariants ?? {},
    groups: (manifest.data.groups ?? []).map((group) => ({
      order: group.order,
      id: group.id,
      message: group.message,
      patchId: group.uniquePatchIds?.[0] ?? null,
      numstatDigest: group.uniqueNumstatDigests?.[0] ?? null,
      summaryDigest: group.uniqueSummaryDigests?.[0] ?? null,
      pathSetDigest: group.uniquePathSetDigests?.[0] ?? null,
      allEquivalent: Boolean(group.allEquivalent),
      commitShaNote: group.commitShaNote ?? null,
    })),
  }
}

function assertGroupLayout(slice, promote, handoff, replay, attest) {
  const expected = slice.commitGroups.map((group, index) => ({
    order: index + 1,
    id: group.id,
    message: group.message,
  }))
  const actualSets = {
    promote: promote.groups,
    handoff: handoff.groups,
    replay: replay.groups,
    attest: attest.groups,
  }

  for (const [label, groups] of Object.entries(actualSets)) {
    if (groups.length !== expected.length) {
      throw Object.assign(
        new Error(`${label} group count mismatch: expected ${expected.length}, got ${groups.length}.`),
        {
          code: 'SUBMIT_GROUP_COUNT_MISMATCH',
          exitCode: 1,
          label,
          expectedCount: expected.length,
          actualCount: groups.length,
        },
      )
    }
    for (let index = 0; index < expected.length; index += 1) {
      const expectedGroup = expected[index]
      const actualGroup = groups[index]
      if (
        expectedGroup.order !== actualGroup.order ||
        expectedGroup.id !== actualGroup.id ||
        expectedGroup.message !== actualGroup.message
      ) {
        throw Object.assign(
          new Error(
            `${label} group mismatch at order ${index + 1}: expected ${expectedGroup.id}/${expectedGroup.message}, got ${actualGroup.id}/${actualGroup.message}.`,
          ),
          {
            code: 'SUBMIT_GROUP_LAYOUT_MISMATCH',
            exitCode: 1,
            label,
            order: index + 1,
          },
        )
      }
    }
  }

  return expected
}

function buildCurrentBaselineStatus() {
  if (!isGitWorkTree()) {
    return {
      available: false,
      githubSyncReady: false,
    }
  }

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = runGit(['rev-parse', 'HEAD'])
  let upstream = null
  let ahead = null
  let behind = null

  try {
    upstream = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const counts = runGit(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
    ahead = Number.isFinite(counts[0]) ? counts[0] : 0
    behind = Number.isFinite(counts[1]) ? counts[1] : 0
  } catch {
    upstream = null
  }

  const statusLines = runGit(['status', '--porcelain'])
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
  const modifiedTrackedCount = statusLines.filter((line) => !line.startsWith('??')).length
  const untrackedCount = statusLines.filter((line) => line.startsWith('??')).length
  const dirty = statusLines.length > 0

  return {
    available: true,
    branch,
    head,
    upstream,
    ahead,
    behind,
    dirty,
    changedFileCount: statusLines.length,
    modifiedTrackedCount,
    untrackedCount,
    githubSyncReady: !dirty && (ahead ?? 0) === 0 && (behind ?? 0) === 0,
  }
}

function buildStageIntegrity(expectedGroups, promote, handoff, replay, attest, currentBaseline) {
  const baseRefAligned =
    promote.baseRef === handoff.baseRef &&
    promote.baseRef === replay.baseRef &&
    promote.baseRef === attest.baseRef
  const baseShaAligned =
    promote.baseSha === handoff.baseSha &&
    promote.baseSha === replay.baseSha &&
    promote.baseSha === attest.baseSha
  const commitCountAligned =
    promote.commitCount === handoff.commitCount &&
    promote.commitCount === replay.commitCount &&
    promote.commitCount === attest.commitCount &&
    promote.commitCount === expectedGroups.length
  const promotedHeadMatchesHandoffSource = promote.head === handoff.sourceHead
  const promotedHeadMatchesReplaySource = promote.head === replay.sourceHead
  const replayHeadMatchesPromotedHead = replay.replayedHead === promote.head
  const bundleShaAligned = handoff.bundleSha256 === replay.bundleSha256
  const groupPatchShasAligned = expectedGroups.every((expectedGroup, index) => {
    const handoffGroup = handoff.groups[index]
    const replayGroup = replay.groups[index]
    return handoffGroup.patchSha256 === replayGroup.patchSha256
  })
  const groupPatchIdsAligned = expectedGroups.every((expectedGroup, index) => {
    const handoffGroup = handoff.groups[index]
    const attestGroup = attest.groups[index]
    return !handoffGroup.patchId || handoffGroup.patchId === attestGroup.patchId
  })
  const attestationAllEquivalent =
    Boolean(attest.invariants.localRoundtripEquivalent) &&
    Boolean(attest.invariants.remoteRoundtripEquivalent) &&
    Boolean(attest.invariants.crossEnvironmentHandoffEquivalent) &&
    Boolean(attest.invariants.crossEnvironmentReplayEquivalent) &&
    Boolean(attest.invariants.allPatchIdsEquivalent) &&
    Boolean(attest.invariants.allNumstatDigestsEquivalent) &&
    Boolean(attest.invariants.allSummaryDigestsEquivalent) &&
    Boolean(attest.invariants.allPathSetDigestsEquivalent) &&
    Boolean(attest.invariants.patchFileNameLayoutEquivalent)
  const groupAttestationEquivalent = attest.groups.every((group) => group.allEquivalent)
  const promotedBranchExists = currentBaseline.available
    ? gitSucceeds(['rev-parse', '--verify', promote.branchName])
    : null

  const sliceReadyForSubmission =
    promote.verifyPassed &&
    handoff.verifyPassed &&
    replay.verifyPassed &&
    attest.verifyPassed &&
    baseRefAligned &&
    baseShaAligned &&
    commitCountAligned &&
    promotedHeadMatchesHandoffSource &&
    promotedHeadMatchesReplaySource &&
    replayHeadMatchesPromotedHead &&
    bundleShaAligned &&
    groupPatchShasAligned &&
    groupPatchIdsAligned &&
    attestationAllEquivalent &&
    groupAttestationEquivalent &&
    (promotedBranchExists === null || promotedBranchExists === true)

  const currentBranchIsPromotedBranch =
    currentBaseline.available && currentBaseline.branch === promote.branchName
  const currentWorktreeReadyForPush =
    currentBaseline.available &&
    !currentBaseline.dirty &&
    (currentBaseline.ahead ?? 0) === 0 &&
    (currentBaseline.behind ?? 0) === 0 &&
    currentBranchIsPromotedBranch

  return {
    baseRefAligned,
    baseShaAligned,
    commitCountAligned,
    promotedHeadMatchesHandoffSource,
    promotedHeadMatchesReplaySource,
    replayHeadMatchesPromotedHead,
    bundleShaAligned,
    groupPatchShasAligned,
    groupPatchIdsAligned,
    attestationAllEquivalent,
    groupAttestationEquivalent,
    promotedBranchExists,
    sliceReadyForSubmission,
    currentBranchIsPromotedBranch,
    currentWorktreeReadyForPush,
  }
}

function buildGroupSummaries(expectedGroups, promote, handoff, replay, attest) {
  return expectedGroups.map((expectedGroup, index) => {
    const promoteGroup = promote.groups[index]
    const handoffGroup = handoff.groups[index]
    const replayGroup = replay.groups[index]
    const attestGroup = attest.groups[index]
    return {
      order: expectedGroup.order,
      id: expectedGroup.id,
      message: expectedGroup.message,
      promotedCommitSha: promoteGroup.promotedCommitSha,
      sourceCommitSha: promoteGroup.sourceCommitSha,
      replayedCommitSha: replayGroup.replayedCommitSha,
      patchFileName: handoffGroup.patchFileName,
      patchSha256: handoffGroup.patchSha256,
      patchId: handoffGroup.patchId ?? attestGroup.patchId,
      numstatDigest: attestGroup.numstatDigest,
      summaryDigest: attestGroup.summaryDigest,
      pathSetDigest: attestGroup.pathSetDigest,
      allEquivalent: attestGroup.allEquivalent,
      committedFiles: promoteGroup.committedFiles,
    }
  })
}

function buildSuggestedCommands(report) {
  const branch = report.promote.branchName
  const baseRef = report.baseRef
  const baseSha = report.baseSha
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'git fetch origin --prune',
    `git switch ${shellEscape(branch)}`,
    `git log --reverse --oneline ${shellEscape(baseSha)}..${shellEscape(branch)}`,
    `git range-diff ${shellEscape(baseRef)}...${shellEscape(branch)} || true`,
    `git push origin ${shellEscape(branch)}`,
  ]
  return `${lines.join('\n')}\n`
}

function buildSummary(report) {
  const lines = [
    `# Git Slice Submit Packet: ${report.slice}`,
    '',
    `- Base ref: \`${report.baseRef}\``,
    `- Base SHA: \`${report.baseSha}\``,
    `- Promoted branch: \`${report.promote.branchName}\``,
    `- Promoted head: \`${report.promote.head}\``,
    `- Slice ready for submission: \`${report.readiness.sliceReadyForSubmission}\``,
    `- Current worktree ready for push: \`${report.readiness.currentWorktreeReadyForPush}\``,
    '',
    '## Stage readiness',
    '',
    `- Promote verified: \`${report.promote.verifyPassed}\``,
    `- Handoff verified: \`${report.handoff.verifyPassed}\``,
    `- Replay verified: \`${report.replay.verifyPassed}\``,
    `- Attest verified: \`${report.attest.verifyPassed}\``,
    `- Base ref aligned: \`${report.readiness.baseRefAligned}\``,
    `- Base SHA aligned: \`${report.readiness.baseShaAligned}\``,
    `- Commit count aligned: \`${report.readiness.commitCountAligned}\``,
    `- Bundle SHA aligned: \`${report.readiness.bundleShaAligned}\``,
    `- Group patch SHAs aligned: \`${report.readiness.groupPatchShasAligned}\``,
    `- Group patch IDs aligned: \`${report.readiness.groupPatchIdsAligned}\``,
    `- Attestation invariants all green: \`${report.readiness.attestationAllEquivalent}\``,
    '',
    '## Commit order',
    '',
  ]

  for (const group of report.groups) {
    lines.push(`1. ${group.id}`)
    lines.push(`   message: ${group.message}`)
    lines.push(`   promoted commit: \`${group.promotedCommitSha}\``)
    lines.push(`   patch: \`${group.patchFileName}\``)
    lines.push(`   patch sha256: \`${group.patchSha256}\``)
    lines.push(`   patch id: \`${group.patchId}\``)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function buildReadme(report) {
  const lines = [
    `# Git Slice Submit Packet: ${report.slice}`,
    '',
    `- Base ref: \`${report.baseRef}\``,
    `- Base SHA: \`${report.baseSha}\``,
    `- Promote manifest: \`${report.inputs.promoteManifest}\``,
    `- Handoff manifest: \`${report.inputs.handoffManifest}\``,
    `- Replay manifest: \`${report.inputs.replayManifest}\``,
    `- Attest manifest: \`${report.inputs.attestManifest}\``,
    '',
    '## What this packet proves',
    '',
    '- The promoted branch is aligned with the handoff source branch.',
    '- The handoff bundle and replay bundle metadata match.',
    '- Replayed patches match handoff patch SHA-256 values.',
    '- Attestation invariants confirm semantic equivalence across local and remote chains.',
    '',
    '## Suggested commands',
    '',
    'See `submit-commands.sh` for the canonical command sequence.',
    '',
    '## Current worktree note',
    '',
    `- Current worktree available: \`${report.currentBaseline.available}\``,
    `- Current worktree githubSyncReady: \`${report.currentBaseline.githubSyncReady}\``,
    `- Current branch is promoted branch: \`${report.readiness.currentBranchIsPromotedBranch}\``,
    '',
  ]

  return `${lines.join('\n')}\n`
}

function printHuman(report) {
  console.log(`git-slice-submit: ${report.slice}`)
  console.log(`  base_ref: ${report.baseRef}`)
  console.log(`  base_sha: ${report.baseSha}`)
  console.log(`  promoted_branch: ${report.promote.branchName}`)
  console.log(`  promoted_head: ${report.promote.head}`)
  console.log(`  slice_ready_for_submission: ${report.readiness.sliceReadyForSubmission}`)
  console.log(`  current_worktree_ready_for_push: ${report.readiness.currentWorktreeReadyForPush}`)
  console.log('  groups:')
  for (const group of report.groups) {
    console.log(`    - ${group.id}`)
    console.log(`      promoted_commit=${group.promotedCommitSha}`)
    console.log(`      patch_sha256=${group.patchSha256}`)
    console.log(`      patch_id=${group.patchId}`)
    console.log(`      all_equivalent=${group.allEquivalent}`)
  }
}

async function buildSubmitPacket(options) {
  const slice = ensureSlice(options.sliceName)
  const promoteManifest = await loadManifest(options.promoteManifest, 'promote', options.sliceName)
  const handoffManifest = await loadManifest(options.handoffManifest, 'handoff', options.sliceName)
  const replayManifest = await loadManifest(options.replayManifest, 'replay', options.sliceName)
  const attestManifest = await loadManifest(options.attestManifest, 'attest', options.sliceName)

  const promote = normalizePromoteManifest(promoteManifest)
  const handoff = normalizeHandoffManifest(handoffManifest)
  const replay = normalizeReplayManifest(replayManifest)
  const attest = normalizeAttestManifest(attestManifest)
  const expectedGroups = assertGroupLayout(slice, promote, handoff, replay, attest)

  const baseRef = assertSingleValue(
    'Submit baseRef',
    [promote.baseRef, handoff.baseRef, replay.baseRef, attest.baseRef],
    'SUBMIT_BASE_REF_MISMATCH',
  )
  const baseSha = assertSingleValue(
    'Submit baseSha',
    [promote.baseSha, handoff.baseSha, replay.baseSha, attest.baseSha],
    'SUBMIT_BASE_SHA_MISMATCH',
  )

  const currentBaseline = buildCurrentBaselineStatus()
  const readiness = buildStageIntegrity(
    expectedGroups,
    promote,
    handoff,
    replay,
    attest,
    currentBaseline,
  )
  const groups = buildGroupSummaries(expectedGroups, promote, handoff, replay, attest)

  const resolvedOutputDir = path.resolve(
    options.outputDir ??
      path.join(
        'output',
        'git-slice-submissions',
        options.sliceName,
        options.verify ? 'verify' : 'submit',
      ),
  )
  await fs.mkdir(resolvedOutputDir, { recursive: true })

  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    description: slice.description,
    verifyMode: options.verify,
    baseRef,
    baseSha,
    inputs: {
      promoteManifest: promoteManifest.path,
      handoffManifest: handoffManifest.path,
      replayManifest: replayManifest.path,
      attestManifest: attestManifest.path,
    },
    promote,
    handoff,
    replay,
    attest,
    readiness,
    currentBaseline,
    groups,
    outputDir: resolvedOutputDir,
    verifyPassed: readiness.sliceReadyForSubmission,
  }

  report.summaryPath = await writeTextFile(
    path.join(resolvedOutputDir, 'submit-summary.md'),
    buildSummary(report),
  )
  report.readmePath = await writeTextFile(
    path.join(resolvedOutputDir, 'README.md'),
    buildReadme(report),
  )
  report.commandsPath = await writeTextFile(
    path.join(resolvedOutputDir, 'submit-commands.sh'),
    buildSuggestedCommands(report),
    true,
  )
  report.outputManifestPath = await writeJsonFile(path.join(resolvedOutputDir, 'manifest.json'), report)

  if (options.writeManifest) {
    report.writtenManifestPath = await writeJsonFile(options.writeManifest, report)
  }

  return report
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const slice = ensureSlice(options.sliceName)

  if (options.listSlices) {
    const names = Object.keys(SLICES).sort((left, right) => left.localeCompare(right))
    if (options.json) {
      console.log(JSON.stringify({ slices: names }, null, 2))
    } else {
      for (const name of names) {
        console.log(name)
      }
    }
    return
  }

  if (options.listGroups) {
    const groups = slice.commitGroups.map((group, index) => ({
      order: index + 1,
      id: group.id,
      message: group.message,
      files: group.files,
    }))
    if (options.json) {
      console.log(JSON.stringify({ slice: options.sliceName, groups }, null, 2))
    } else {
      for (const group of groups) {
        console.log(`${group.order}. ${group.id}: ${group.message}`)
      }
    }
    return
  }

  const report = await buildSubmitPacket(options)
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHuman(report)
  }

  if (!report.verifyPassed) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  if (error?.code === 'UNKNOWN_SLICE') {
    console.error(`git-slice-submit: ${error.message}`)
  } else {
    console.error(error?.stack ?? String(error))
  }
  process.exit(error?.exitCode ?? 1)
})
