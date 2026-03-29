#!/usr/bin/env node

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { SLICES } from './git-slices.mjs'

function runGit(args, extra = {}) {
  return execFileSync('git', args, {
    cwd: extra.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: extra.input,
    env: {
      ...process.env,
      ...(extra.env ?? {}),
    },
  }).trimEnd()
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let localHandoffManifest = null
  let localReplayManifest = null
  let remoteHandoffManifest = null
  let remoteReplayManifest = null
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
      case '--local-handoff-manifest':
        localHandoffManifest = argv[index + 1] ?? localHandoffManifest
        index += 1
        break
      case '--local-replay-manifest':
        localReplayManifest = argv[index + 1] ?? localReplayManifest
        index += 1
        break
      case '--remote-handoff-manifest':
        remoteHandoffManifest = argv[index + 1] ?? remoteHandoffManifest
        index += 1
        break
      case '--remote-replay-manifest':
        remoteReplayManifest = argv[index + 1] ?? remoteReplayManifest
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

  return {
    sliceName,
    localHandoffManifest,
    localReplayManifest,
    remoteHandoffManifest,
    remoteReplayManifest,
    outputDir,
    writeManifest,
    json,
    verify,
    listSlices,
    listGroups,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-attest.mjs [options]

Options:
  --slice <name>                   Slice name. Default: directory-migration-baseline
  --local-handoff-manifest <path>  Override local handoff manifest
  --local-replay-manifest <path>   Override local replay manifest
  --remote-handoff-manifest <path> Override remote handoff manifest
  --remote-replay-manifest <path>  Override remote replay manifest
  --output-dir <path>              Write attestation report and summary files
  --write-manifest <path>          Write report JSON to the given path
  --verify                         Mark this attestation as verify mode
  --list-slices                    Print available slices
  --list-groups                    Print groups for the selected slice
  --json                           Print JSON
  --help, -h                       Show help`)
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

function resolveManifestDefaults(options) {
  const sliceName = options.sliceName
  return {
    localHandoffManifest:
      options.localHandoffManifest ??
      path.join('output', 'git-slice-handoffs', sliceName, 'manifest.json'),
    localReplayManifest:
      options.localReplayManifest ??
      path.join('output', 'git-slice-replays', sliceName, 'manifest.json'),
    remoteHandoffManifest:
      options.remoteHandoffManifest ??
      path.join(
        'output',
        'remote-git-slice-handoffs',
        sliceName,
        'handoff',
        'artifacts',
        'manifest.json',
      ),
    remoteReplayManifest:
      options.remoteReplayManifest ??
      path.join(
        'output',
        'remote-git-slice-replays',
        sliceName,
        'replay',
        'artifacts',
        'manifest.json',
      ),
  }
}

function resolveArtifactPath(candidates, errorCode, message) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    const resolved = path.resolve(candidate)
    if (existsSync(resolved)) {
      return resolved
    }
  }

  throw Object.assign(new Error(message), {
    code: errorCode,
    exitCode: 1,
    candidates: candidates.filter(Boolean).map((candidate) => path.resolve(candidate)),
  })
}

async function writeTextFile(filePath, contents) {
  const resolvedPath = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, contents, 'utf8')
  return resolvedPath
}

async function writeJsonFile(filePath, payload) {
  return writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

function digestText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalizeMultilineText(value) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .sort((left, right) => left.localeCompare(right))
  return lines.join('\n')
}

function buildPathSet(patchText) {
  const values = []
  const pattern = /^diff --git a\/(.+?) b\/(.+)$/gm
  for (const match of patchText.matchAll(pattern)) {
    values.push(`${match[1]}\t${match[2]}`)
  }
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

async function computePatchEvidence(filePath) {
  const bytes = await fs.readFile(filePath)
  const patchText = bytes.toString('utf8')
  const patchIdOutput = runGit(['patch-id', '--stable'], { input: bytes })
  const [patchId] = patchIdOutput.split(/\s+/)
  const numstatText = runGit(['apply', '--numstat', '-'], { input: bytes })
  const summaryText = runGit(['apply', '--summary', '-'], { input: bytes })
  const pathSet = buildPathSet(patchText)
  const normalizedNumstat = normalizeMultilineText(numstatText)
  const normalizedSummary = normalizeMultilineText(summaryText)
  const normalizedPathSet = pathSet.join('\n')

  return {
    patchId,
    numstatDigest: digestText(normalizedNumstat),
    summaryDigest: digestText(normalizedSummary),
    pathSetDigest: digestText(normalizedPathSet),
    pathSet,
  }
}

async function loadManifest(manifestPath, sliceName, label) {
  const resolvedPath = resolveArtifactPath(
    [manifestPath],
    'MISSING_MANIFEST',
    `Unable to resolve ${label} manifest for slice ${sliceName}.`,
  )
  const raw = await fs.readFile(resolvedPath, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed.slice && parsed.slice !== sliceName) {
    throw Object.assign(
      new Error(`Manifest slice mismatch in ${label}: expected ${sliceName}, got ${parsed.slice}.`),
      {
        code: 'MANIFEST_SLICE_MISMATCH',
        exitCode: 1,
        manifestPath: resolvedPath,
        label,
      },
    )
  }
  return {
    label,
    path: resolvedPath,
    dir: path.dirname(resolvedPath),
    data: parsed,
  }
}

function buildPatchMetaIndex(manifestData) {
  const index = new Map()

  for (const patchFile of manifestData.patchFiles ?? []) {
    index.set(`${patchFile.order}:${patchFile.fileName}`, patchFile)
    index.set(`name:${patchFile.fileName}`, patchFile)
  }

  for (const comparison of manifestData.patchComparisons ?? []) {
    const normalized = {
      order: comparison.order,
      fileName: comparison.fileName,
      path: comparison.replayPath,
      sha256: comparison.replaySha256,
    }
    index.set(`${comparison.order}:${comparison.fileName}`, normalized)
    index.set(`name:${comparison.fileName}`, normalized)
  }

  return index
}

async function resolveManifestGroups(manifestContext, expectedGroups) {
  const groups = manifestContext.data.groups ?? []
  if (groups.length !== expectedGroups.length) {
    throw Object.assign(
      new Error(
        `${manifestContext.label} group count mismatch: expected ${expectedGroups.length}, got ${groups.length}.`,
      ),
      {
        code: 'GROUP_COUNT_MISMATCH',
        exitCode: 1,
        label: manifestContext.label,
      },
    )
  }

  const patchIndex = buildPatchMetaIndex(manifestContext.data)
  const resolvedGroups = []

  for (const [index, group] of groups.entries()) {
    const expected = expectedGroups[index]
    if (group.id !== expected.id || group.message !== expected.message) {
      throw Object.assign(
        new Error(
          `${manifestContext.label} group mismatch at order ${index + 1}: expected ${expected.id}/${expected.message}, got ${group.id}/${group.message}.`,
        ),
        {
          code: 'GROUP_LAYOUT_MISMATCH',
          exitCode: 1,
          label: manifestContext.label,
          order: index + 1,
        },
      )
    }

    const patchMeta =
      patchIndex.get(`${index + 1}:${group.patchFileName}`) ??
      patchIndex.get(`name:${group.patchFileName}`) ??
      null
    const fileName = group.patchFileName ?? patchMeta?.fileName ?? null
    if (!fileName) {
      throw Object.assign(
        new Error(`Unable to resolve patch file for ${manifestContext.label} group ${group.id}.`),
        {
          code: 'PATCH_FILE_NAME_REQUIRED',
          exitCode: 1,
          label: manifestContext.label,
          groupId: group.id,
        },
      )
    }

    const patchPath = resolveArtifactPath(
      [
        group.patchPath,
        patchMeta?.path,
        path.join(manifestContext.dir, 'patches', fileName),
      ],
      'MISSING_PATCH_FILE',
      `Unable to resolve ${manifestContext.label} patch ${fileName}.`,
    )

    const patchSha256 = await sha256File(patchPath)
    const patchEvidence = await computePatchEvidence(patchPath)

    resolvedGroups.push({
      order: index + 1,
      id: group.id,
      message: group.message,
      patchFileName: fileName,
      patchPath,
      patchSha256,
      patchId: patchEvidence.patchId,
      numstatDigest: patchEvidence.numstatDigest,
      summaryDigest: patchEvidence.summaryDigest,
      pathSetDigest: patchEvidence.pathSetDigest,
      pathSet: patchEvidence.pathSet,
      sourceCommitSha: group.sourceCommitSha ?? null,
      replayedCommitSha: group.replayedCommitSha ?? null,
      commitSha:
        group.sourceCommitSha ??
        group.replayedCommitSha ??
        group.promotedCommitSha ??
        group.commitSha ??
        null,
    })
  }

  return resolvedGroups
}

function buildCommitShaSummary(groups) {
  const values = groups.map((group) => group.commitSha).filter(Boolean)
  return {
    uniqueCommitShas: [...new Set(values)],
    uniqueCount: new Set(values).size,
  }
}

function pickManifestMeta(manifestContext, groups) {
  return {
    label: manifestContext.label,
    manifestPath: manifestContext.path,
    baseRef: manifestContext.data.baseRef ?? null,
    baseSha: manifestContext.data.baseSha ?? null,
    sourceBranch: manifestContext.data.sourceBranch ?? null,
    sourceHead: manifestContext.data.sourceHead ?? null,
    bundleSha256: manifestContext.data.bundleSha256 ?? null,
    verifyMode: Boolean(manifestContext.data.verifyMode),
    commitCount: manifestContext.data.commitCount ?? groups.length,
    groups,
    commitSummary: buildCommitShaSummary(groups),
  }
}

function assertManifestMetaConsistent(manifests) {
  const baseRefs = [...new Set(manifests.map((entry) => entry.baseRef).filter(Boolean))]
  if (baseRefs.length !== 1) {
    throw Object.assign(new Error(`Attestation baseRef mismatch: ${baseRefs.join(', ')}`), {
      code: 'ATTEST_BASE_REF_MISMATCH',
      exitCode: 1,
      baseRefs,
    })
  }

  const baseShas = [...new Set(manifests.map((entry) => entry.baseSha).filter(Boolean))]
  if (baseShas.length !== 1) {
    throw Object.assign(new Error(`Attestation baseSha mismatch: ${baseShas.join(', ')}`), {
      code: 'ATTEST_BASE_SHA_MISMATCH',
      exitCode: 1,
      baseShas,
    })
  }

  const commitCounts = [...new Set(manifests.map((entry) => entry.commitCount))]
  if (commitCounts.length !== 1) {
    throw Object.assign(new Error(`Attestation commitCount mismatch: ${commitCounts.join(', ')}`), {
      code: 'ATTEST_COMMIT_COUNT_MISMATCH',
      exitCode: 1,
      commitCounts,
    })
  }

  return {
    baseRef: baseRefs[0],
    baseSha: baseShas[0],
    commitCount: commitCounts[0],
  }
}

function compareGroupAttestation(groupSet) {
  const patchIds = {
    localHandoff: groupSet.localHandoff.patchId,
    localReplay: groupSet.localReplay.patchId,
    remoteHandoff: groupSet.remoteHandoff.patchId,
    remoteReplay: groupSet.remoteReplay.patchId,
  }
  const numstatDigests = {
    localHandoff: groupSet.localHandoff.numstatDigest,
    localReplay: groupSet.localReplay.numstatDigest,
    remoteHandoff: groupSet.remoteHandoff.numstatDigest,
    remoteReplay: groupSet.remoteReplay.numstatDigest,
  }
  const summaryDigests = {
    localHandoff: groupSet.localHandoff.summaryDigest,
    localReplay: groupSet.localReplay.summaryDigest,
    remoteHandoff: groupSet.remoteHandoff.summaryDigest,
    remoteReplay: groupSet.remoteReplay.summaryDigest,
  }
  const pathSetDigests = {
    localHandoff: groupSet.localHandoff.pathSetDigest,
    localReplay: groupSet.localReplay.pathSetDigest,
    remoteHandoff: groupSet.remoteHandoff.pathSetDigest,
    remoteReplay: groupSet.remoteReplay.pathSetDigest,
  }
  const patchFileNames = {
    localHandoff: groupSet.localHandoff.patchFileName,
    localReplay: groupSet.localReplay.patchFileName,
    remoteHandoff: groupSet.remoteHandoff.patchFileName,
    remoteReplay: groupSet.remoteReplay.patchFileName,
  }
  const uniquePatchIds = [...new Set(Object.values(patchIds))]
  const uniqueNumstatDigests = [...new Set(Object.values(numstatDigests))]
  const uniqueSummaryDigests = [...new Set(Object.values(summaryDigests))]
  const uniquePathSetDigests = [...new Set(Object.values(pathSetDigests))]
  const uniquePatchFileNames = [...new Set(Object.values(patchFileNames))]
  const patchFileNameEquivalent = uniquePatchFileNames.length === 1
  const localRoundtripEquivalent =
    patchIds.localHandoff === patchIds.localReplay &&
    numstatDigests.localHandoff === numstatDigests.localReplay &&
    summaryDigests.localHandoff === summaryDigests.localReplay &&
    pathSetDigests.localHandoff === pathSetDigests.localReplay
  const remoteRoundtripEquivalent =
    patchIds.remoteHandoff === patchIds.remoteReplay &&
    numstatDigests.remoteHandoff === numstatDigests.remoteReplay &&
    summaryDigests.remoteHandoff === summaryDigests.remoteReplay &&
    pathSetDigests.remoteHandoff === pathSetDigests.remoteReplay
  const crossEnvironmentHandoffEquivalent =
    patchIds.localHandoff === patchIds.remoteHandoff &&
    numstatDigests.localHandoff === numstatDigests.remoteHandoff &&
    summaryDigests.localHandoff === summaryDigests.remoteHandoff &&
    pathSetDigests.localHandoff === pathSetDigests.remoteHandoff
  const crossEnvironmentReplayEquivalent =
    patchIds.localReplay === patchIds.remoteReplay &&
    numstatDigests.localReplay === numstatDigests.remoteReplay &&
    summaryDigests.localReplay === summaryDigests.remoteReplay &&
    pathSetDigests.localReplay === pathSetDigests.remoteReplay
  const allEquivalent =
    uniquePatchIds.length === 1 &&
    uniqueNumstatDigests.length === 1 &&
    uniqueSummaryDigests.length === 1 &&
    uniquePathSetDigests.length === 1 &&
    patchFileNameEquivalent

  return {
    order: groupSet.localHandoff.order,
    id: groupSet.localHandoff.id,
    message: groupSet.localHandoff.message,
    patchIds,
    numstatDigests,
    summaryDigests,
    pathSetDigests,
    patchFileNames,
    uniquePatchIds,
    uniqueNumstatDigests,
    uniqueSummaryDigests,
    uniquePathSetDigests,
    uniquePatchFileNames,
    patchFileNameEquivalent,
    localRoundtripEquivalent,
    remoteRoundtripEquivalent,
    crossEnvironmentHandoffEquivalent,
    crossEnvironmentReplayEquivalent,
    allEquivalent,
    localHandoff: groupSet.localHandoff,
    localReplay: groupSet.localReplay,
    remoteHandoff: groupSet.remoteHandoff,
    remoteReplay: groupSet.remoteReplay,
    commitShaNote:
      groupSet.localHandoff.commitSha === groupSet.remoteHandoff.commitSha &&
      groupSet.localReplay.commitSha === groupSet.remoteReplay.commitSha
        ? 'commit-shas-match'
        : 'commit-shas-may-differ-across-promote-replay-environments',
  }
}

function buildSummary(report) {
  const lines = [
    `# Git Slice Attestation: ${report.slice}`,
    '',
    `- Base ref: \`${report.baseRef}\``,
    `- Base SHA: \`${report.baseSha}\``,
    `- Group count: \`${report.commitCount}\``,
    `- Verify passed: \`${report.verifyPassed}\``,
    '',
    '## Invariants',
    '',
    `- Local handoff vs local replay: \`${report.invariants.localRoundtripEquivalent}\``,
    `- Remote handoff vs remote replay: \`${report.invariants.remoteRoundtripEquivalent}\``,
    `- Local handoff vs remote handoff: \`${report.invariants.crossEnvironmentHandoffEquivalent}\``,
    `- Local replay vs remote replay: \`${report.invariants.crossEnvironmentReplayEquivalent}\``,
    `- All patch IDs equivalent: \`${report.invariants.allPatchIdsEquivalent}\``,
    `- All numstat digests equivalent: \`${report.invariants.allNumstatDigestsEquivalent}\``,
    `- All summary digests equivalent: \`${report.invariants.allSummaryDigestsEquivalent}\``,
    `- All path-set digests equivalent: \`${report.invariants.allPathSetDigestsEquivalent}\``,
    `- Patch file name layout equivalent: \`${report.invariants.patchFileNameLayoutEquivalent}\``,
    '',
    '## Groups',
    '',
  ]

  for (const group of report.groups) {
    lines.push(`1. ${group.id}`)
    lines.push(`   message: ${group.message}`)
    lines.push(`   patch id: \`${group.uniquePatchIds[0]}\``)
    lines.push(`   numstat digest: \`${group.uniqueNumstatDigests[0]}\``)
    lines.push(`   summary digest: \`${group.uniqueSummaryDigests[0]}\``)
    lines.push(`   path-set digest: \`${group.uniquePathSetDigests[0]}\``)
    lines.push(`   all equivalent: \`${group.allEquivalent}\``)
    lines.push(`   note: ${group.commitShaNote}`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function buildReadme(report) {
  const lines = [
    `# Git Slice Attestation Report: ${report.slice}`,
    '',
    `- Base ref: \`${report.baseRef}\``,
    `- Base SHA: \`${report.baseSha}\``,
    `- Commit count: \`${report.commitCount}\``,
    `- Verify passed: \`${report.verifyPassed}\``,
    '',
    '## Source manifests',
    '',
    `- Local handoff: \`${report.inputs.localHandoffManifest}\``,
    `- Local replay: \`${report.inputs.localReplayManifest}\``,
    `- Remote handoff: \`${report.inputs.remoteHandoffManifest}\``,
    `- Remote replay: \`${report.inputs.remoteReplayManifest}\``,
    '',
    '## Expected differences',
    '',
    '- Cross-environment commit SHAs may differ because remote promote / replay replays commits in a separate Git clone.',
    '- Attestation therefore uses stable `patch-id` plus normalized `numstat` / `summary` / `path-set` digests as the semantic equivalence metric.',
    '',
  ]

  for (const group of report.groups) {
    lines.push(`### ${group.order}. ${group.id}`)
    lines.push('')
    lines.push(`- Message: ${group.message}`)
    lines.push(`- Local handoff patch-id: \`${group.patchIds.localHandoff}\``)
    lines.push(`- Local replay patch-id: \`${group.patchIds.localReplay}\``)
    lines.push(`- Remote handoff patch-id: \`${group.patchIds.remoteHandoff}\``)
    lines.push(`- Remote replay patch-id: \`${group.patchIds.remoteReplay}\``)
    lines.push(`- Local handoff numstat digest: \`${group.numstatDigests.localHandoff}\``)
    lines.push(`- Remote handoff numstat digest: \`${group.numstatDigests.remoteHandoff}\``)
    lines.push(`- Local handoff summary digest: \`${group.summaryDigests.localHandoff}\``)
    lines.push(`- Remote handoff summary digest: \`${group.summaryDigests.remoteHandoff}\``)
    lines.push(`- Local handoff path-set digest: \`${group.pathSetDigests.localHandoff}\``)
    lines.push(`- Remote handoff path-set digest: \`${group.pathSetDigests.remoteHandoff}\``)
    lines.push(`- Patch file names aligned: \`${group.patchFileNameEquivalent}\``)
    lines.push(`- Equivalent: \`${group.allEquivalent}\``)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

async function buildAttestation(options) {
  const slice = ensureSlice(options.sliceName)
  const defaults = resolveManifestDefaults(options)
  const expectedGroups = slice.commitGroups.map((group, index) => ({
    id: group.id,
    message: group.message,
    order: index + 1,
  }))

  const manifestContexts = {
    localHandoff: await loadManifest(defaults.localHandoffManifest, options.sliceName, 'local-handoff'),
    localReplay: await loadManifest(defaults.localReplayManifest, options.sliceName, 'local-replay'),
    remoteHandoff: await loadManifest(defaults.remoteHandoffManifest, options.sliceName, 'remote-handoff'),
    remoteReplay: await loadManifest(defaults.remoteReplayManifest, options.sliceName, 'remote-replay'),
  }

  const manifests = {
    localHandoff: pickManifestMeta(
      manifestContexts.localHandoff,
      await resolveManifestGroups(manifestContexts.localHandoff, expectedGroups),
    ),
    localReplay: pickManifestMeta(
      manifestContexts.localReplay,
      await resolveManifestGroups(manifestContexts.localReplay, expectedGroups),
    ),
    remoteHandoff: pickManifestMeta(
      manifestContexts.remoteHandoff,
      await resolveManifestGroups(manifestContexts.remoteHandoff, expectedGroups),
    ),
    remoteReplay: pickManifestMeta(
      manifestContexts.remoteReplay,
      await resolveManifestGroups(manifestContexts.remoteReplay, expectedGroups),
    ),
  }

  const manifestList = Object.values(manifests)
  const meta = assertManifestMetaConsistent(manifestList)

  const groups = expectedGroups.map((expected, index) =>
    compareGroupAttestation({
      localHandoff: manifests.localHandoff.groups[index],
      localReplay: manifests.localReplay.groups[index],
      remoteHandoff: manifests.remoteHandoff.groups[index],
      remoteReplay: manifests.remoteReplay.groups[index],
      expected,
    }),
  )

  const invariants = {
    localRoundtripEquivalent: groups.every((group) => group.localRoundtripEquivalent),
    remoteRoundtripEquivalent: groups.every((group) => group.remoteRoundtripEquivalent),
    crossEnvironmentHandoffEquivalent: groups.every((group) => group.crossEnvironmentHandoffEquivalent),
    crossEnvironmentReplayEquivalent: groups.every((group) => group.crossEnvironmentReplayEquivalent),
    allPatchIdsEquivalent: groups.every((group) => group.uniquePatchIds.length === 1),
    allNumstatDigestsEquivalent: groups.every((group) => group.uniqueNumstatDigests.length === 1),
    allSummaryDigestsEquivalent: groups.every((group) => group.uniqueSummaryDigests.length === 1),
    allPathSetDigestsEquivalent: groups.every((group) => group.uniquePathSetDigests.length === 1),
    patchFileNameLayoutEquivalent: groups.every((group) => group.patchFileNameEquivalent),
  }

  const verifyPassed =
    invariants.localRoundtripEquivalent &&
    invariants.remoteRoundtripEquivalent &&
    invariants.crossEnvironmentHandoffEquivalent &&
    invariants.crossEnvironmentReplayEquivalent &&
    invariants.allPatchIdsEquivalent &&
    invariants.allNumstatDigestsEquivalent &&
    invariants.allSummaryDigestsEquivalent &&
    invariants.allPathSetDigestsEquivalent &&
    invariants.patchFileNameLayoutEquivalent

  const resolvedOutputDir = path.resolve(
    options.outputDir ??
      path.join(
        'output',
        'git-slice-attestations',
        options.sliceName,
        options.verify ? 'verify' : 'attest',
      ),
  )
  await fs.mkdir(resolvedOutputDir, { recursive: true })

  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    description: slice.description,
    verifyMode: options.verify,
    baseRef: meta.baseRef,
    baseSha: meta.baseSha,
    commitCount: meta.commitCount,
    inputs: {
      localHandoffManifest: manifestContexts.localHandoff.path,
      localReplayManifest: manifestContexts.localReplay.path,
      remoteHandoffManifest: manifestContexts.remoteHandoff.path,
      remoteReplayManifest: manifestContexts.remoteReplay.path,
    },
    manifests,
    invariants,
    groups,
    outputDir: resolvedOutputDir,
    verifyPassed,
  }

  report.summaryPath = await writeTextFile(
    path.join(resolvedOutputDir, 'attestation-summary.md'),
    buildSummary(report),
  )
  report.readmePath = await writeTextFile(
    path.join(resolvedOutputDir, 'README.md'),
    buildReadme(report),
  )
  report.outputManifestPath = await writeJsonFile(path.join(resolvedOutputDir, 'manifest.json'), report)

  return report
}

function printHuman(report) {
  console.log(`git-slice-attest: ${report.slice}`)
  console.log(`  base_ref: ${report.baseRef}`)
  console.log(`  base_sha: ${report.baseSha}`)
  console.log(`  verify_passed: ${report.verifyPassed}`)
  console.log(`  output_dir: ${report.outputDir}`)
  console.log('  invariants:')
  console.log(`    local_roundtrip=${report.invariants.localRoundtripEquivalent}`)
  console.log(`    remote_roundtrip=${report.invariants.remoteRoundtripEquivalent}`)
  console.log(`    cross_env_handoff=${report.invariants.crossEnvironmentHandoffEquivalent}`)
  console.log(`    cross_env_replay=${report.invariants.crossEnvironmentReplayEquivalent}`)
  console.log(`    all_patch_ids=${report.invariants.allPatchIdsEquivalent}`)
  console.log(`    all_numstat_digests=${report.invariants.allNumstatDigestsEquivalent}`)
  console.log(`    all_summary_digests=${report.invariants.allSummaryDigestsEquivalent}`)
  console.log(`    all_path_set_digests=${report.invariants.allPathSetDigestsEquivalent}`)
  console.log(`    patch_file_name_layout=${report.invariants.patchFileNameLayoutEquivalent}`)
  console.log('  groups:')
  for (const group of report.groups) {
    console.log(`    - ${group.id}`)
    console.log(`      patch_id=${group.uniquePatchIds[0]}`)
    console.log(`      numstat_digest=${group.uniqueNumstatDigests[0]}`)
    console.log(`      summary_digest=${group.uniqueSummaryDigests[0]}`)
    console.log(`      path_set_digest=${group.uniquePathSetDigests[0]}`)
    console.log(`      equivalent=${group.allEquivalent}`)
    console.log(`      note=${group.commitShaNote}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const slice = ensureSlice(options.sliceName)

  if (options.listSlices) {
    for (const [name, value] of Object.entries(SLICES)) {
      console.log(`${name}\t${value.description}`)
    }
    return
  }

  if (options.listGroups) {
    slice.commitGroups.forEach((group, index) => {
      console.log(`${index + 1}. ${group.id}\t${group.message}`)
    })
    return
  }

  const report = await buildAttestation(options)

  if (options.writeManifest) {
    await writeJsonFile(options.writeManifest, report)
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printHuman(report)
}

main().catch((error) => {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
  const payload = {
    error: error?.code ?? 'UNEXPECTED_ERROR',
    message: error?.message ?? String(error),
  }

  const extraKeys = [
    'label',
    'groupId',
    'order',
    'baseRefs',
    'baseShas',
    'commitCounts',
    'manifestPath',
    'candidates',
  ]
  for (const key of extraKeys) {
    if (error?.[key] !== undefined) {
      payload[key] = error[key]
    }
  }

  console.error(JSON.stringify(payload, null, 2))
  process.exit(exitCode)
})
