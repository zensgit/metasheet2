#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_DIR = 'artifacts/dingtalk-staging-evidence-packet'

const requiredPacketFiles = [
  {
    path: 'docs/development/dingtalk-staging-canary-deploy-20260408.md',
    kind: 'runbook',
    description: 'staging topology, deploy, rollback, and drift recovery notes',
  },
  {
    path: 'docs/development/dingtalk-staging-execution-checklist-20260408.md',
    kind: 'checklist',
    description: 'tenant inputs, execution order, pass criteria, and stop conditions',
  },
  {
    path: 'docs/development/dingtalk-live-tenant-validation-checklist-20260408.md',
    kind: 'checklist',
    description: 'live tenant validation scope for login, directory, attendance, and robot send',
  },
  {
    path: 'docs/development/dingtalk-stack-merge-readiness-20260408.md',
    kind: 'readiness',
    description: 'DingTalk stack merge readiness context',
  },
  {
    path: 'docs/dingtalk-admin-operations-guide-20260420.md',
    kind: 'operations-guide',
    description: 'admin procedures for DingTalk app setup, directory users, group robots, and troubleshooting',
  },
  {
    path: 'docs/dingtalk-user-workflow-guide-20260422.md',
    kind: 'user-guide',
    description: 'table-owner workflow for DingTalk group/person notifications and protected form links',
  },
  {
    path: 'docs/dingtalk-synced-account-local-user-guide-20260420.md',
    kind: 'user-governance-guide',
    description: 'manual and auto-admission paths for DingTalk-synced accounts, including no-email users',
  },
  {
    path: 'docs/dingtalk-remote-smoke-checklist-20260422.md',
    kind: 'checklist',
    description: 'P4 remote smoke checklist for protected forms, multi-group sends, and DingTalk-bound users',
  },
  {
    path: 'docs/development/dingtalk-feature-plan-and-todo-20260422.md',
    kind: 'plan',
    description: 'current DingTalk feature plan, TODO status, and remaining remote smoke tasks',
  },
  {
    path: 'docker/app.staging.env.example',
    kind: 'config-template',
    description: 'canonical staging env template; copy to docker/app.staging.env and fill secrets',
  },
  {
    path: 'scripts/ops/validate-env-file.sh',
    kind: 'script',
    description: 'fails fast on corrupted one-line env files before docker compose runs',
  },
  {
    path: 'scripts/ops/repair-env-file.sh',
    kind: 'script',
    description: 'repairs env files that contain literal \\n sequences',
  },
  {
    path: 'scripts/ops/build-dingtalk-staging-images.sh',
    kind: 'script',
    description: 'builds local PR-stack images for staging when GHCR tags are unavailable',
  },
  {
    path: 'scripts/ops/deploy-dingtalk-staging.sh',
    kind: 'script',
    description: 'validates env, resolves image tag, runs docker compose, and checks backend health',
  },
  {
    path: 'scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs',
    kind: 'script',
    description: 'compiles redacted P4 remote-smoke evidence summaries from operator-provided results',
  },
]

function printHelp() {
  console.log(`Usage: node scripts/ops/export-dingtalk-staging-evidence-packet.mjs [options]

Exports the DingTalk/shared-dev staging operations packet into one artifact directory.

Options:
  --output-dir <dir>        Output directory, default ${DEFAULT_OUTPUT_DIR}
  --include-output <dir>    Optional existing evidence directory to copy into evidence/
  --help                    Show this help

Examples:
  node scripts/ops/export-dingtalk-staging-evidence-packet.mjs
  node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \\
    --include-output output/playwright/dingtalk-directory-staging-smoke/20260416-package-script
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function parseArgs(argv) {
  const opts = {
    outputDir: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR),
    includeOutputDirs: [],
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    switch (arg) {
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--include-output':
        opts.includeOutputDirs.push(path.resolve(process.cwd(), readRequiredValue(argv, i, arg)))
        i += 1
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function ensureSourceFile(file) {
  const source = path.resolve(process.cwd(), file)
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`missing required packet file: ${file}`)
  }
  return source
}

function copyFileIntoPacket(file, outputDir) {
  const source = ensureSourceFile(file)
  const destination = path.join(outputDir, file)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination)
  return destination
}

function sanitizeEvidenceName(sourceDir) {
  return path
    .basename(sourceDir)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'evidence'
}

function copyEvidenceDir(sourceDir, outputDir, index) {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`--include-output must point to an existing directory: ${sourceDir}`)
  }

  const destinationName = `${String(index + 1).padStart(2, '0')}-${sanitizeEvidenceName(sourceDir)}`
  const destination = path.join(outputDir, 'evidence', destinationName)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(sourceDir, destination, { recursive: true })
  return {
    source: path.relative(process.cwd(), sourceDir).replaceAll('\\', '/'),
    destination: path.relative(outputDir, destination).replaceAll('\\', '/'),
  }
}

function renderReadme(manifest) {
  const docs = manifest.files.filter((file) => file.kind !== 'script')
  const scripts = manifest.files.filter((file) => file.kind === 'script')
  const evidence = manifest.includedEvidence

  const fileLine = (file) => `- \`${file.path}\` — ${file.description}`
  const evidenceLines = evidence.length
    ? evidence.map((entry) => `- \`${entry.destination}\` copied from \`${entry.source}\``).join('\n')
    : '- No runtime evidence directory was included. Re-run with `--include-output <dir>` after staging smoke.'

  return `# DingTalk Staging Evidence Packet

Generated at: ${manifest.generatedAt}

This packet is the operator handoff bundle for the shared-dev/142 DingTalk
staging stack. It is intentionally read-only: exporting it does not deploy,
call Docker, hit staging, or require credentials.

## Included Docs And Config

${docs.map(fileLine).join('\n')}

## Included Scripts

${scripts.map(fileLine).join('\n')}

## Included Runtime Evidence

${evidenceLines}

## Recommended Order

1. Read \`docs/development/dingtalk-staging-canary-deploy-20260408.md\`.
2. Copy \`docker/app.staging.env.example\` to \`docker/app.staging.env\` and fill real secrets on the server only.
3. Validate the env with \`bash scripts/ops/validate-env-file.sh docker/app.staging.env\`.
4. Deploy a pinned tag with \`DEPLOY_IMAGE_TAG=<tag> bash scripts/ops/deploy-dingtalk-staging.sh\`.
5. Execute \`docs/development/dingtalk-staging-execution-checklist-20260408.md\`.
6. Execute \`docs/dingtalk-remote-smoke-checklist-20260422.md\` for P4 DingTalk form/group/person coverage.
7. Compile smoke evidence with \`node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs --input <evidence.json> --output-dir <evidence-dir> --strict\`.
8. Re-export this packet with \`--include-output <evidence-dir>\` after smoke evidence exists.

## Non-Goals

- Does not store secrets.
- Does not mutate \`docker/app.staging.env\`.
- Does not run remote smoke tests.
- Does not decide whether a staging result is production-ready.
`
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    mkdirSync(opts.outputDir, { recursive: true })

    const copiedFiles = requiredPacketFiles.map((entry) => {
      const destination = copyFileIntoPacket(entry.path, opts.outputDir)
      console.log(`Copied ${entry.path}`)
      return {
        ...entry,
        destination: path.relative(opts.outputDir, destination).replaceAll('\\', '/'),
      }
    })

    const includedEvidence = opts.includeOutputDirs.map((dir, index) => {
      const copied = copyEvidenceDir(dir, opts.outputDir, index)
      console.log(`Copied evidence ${copied.source}`)
      return copied
    })

    const manifest = {
      packet: 'dingtalk-staging-evidence-packet',
      generatedAt: new Date().toISOString(),
      repoRoot: process.cwd(),
      files: copiedFiles,
      includedEvidence,
    }

    const manifestPath = path.join(opts.outputDir, 'manifest.json')
    const readmePath = path.join(opts.outputDir, 'README.md')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    writeFileSync(readmePath, `${renderReadme(manifest)}\n`, 'utf8')
    console.log(`Wrote ${path.relative(process.cwd(), manifestPath)}`)
    console.log(`Wrote ${path.relative(process.cwd(), readmePath)}`)
  } catch (error) {
    console.error(`[export-dingtalk-staging-evidence-packet] ERROR: ${error.message}`)
    process.exit(1)
  }
}

await main()
