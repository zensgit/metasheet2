#!/usr/bin/env node

import crypto from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_OUTPUT_ROOT = 'artifacts/dingtalk-screenshot-archive'
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif'])

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-screenshot-archive.mjs [options]

Creates a redaction-safe DingTalk screenshot evidence archive.

Options:
  --input <path>       Screenshot file or directory, repeatable (required)
  --output-dir <dir>   Archive directory, default ${DEFAULT_OUTPUT_ROOT}/<timestamp>
  --allow-empty        Exit successfully when no screenshot files are found
  --help               Show this help

Notes:
  - Images are copied to screenshots/screenshot-NNN.<ext>.
  - manifest.json and README.md contain redacted source labels, sizes, and SHA-256 hashes.
  - The tool does not OCR or inspect screenshot pixels; keep raw screenshot archives access-restricted.
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const opts = {
    inputs: [],
    outputDir: '',
    allowEmpty: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--input':
        opts.inputs.push(path.resolve(process.cwd(), readRequiredValue(argv, i, arg)))
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--allow-empty':
        opts.allowEmpty = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (opts.inputs.length === 0) throw new Error('--input is required')
  opts.outputDir ||= path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, timestampSlug())
  return opts
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function redactString(value) {
  return String(value)
    .replace(/https:\/\/oapi\.dingtalk\.com\/robot\/send\?[^)\s"'`<>]+/gi, 'https://oapi.dingtalk.com/robot/send?<redacted>')
    .replace(/(access_token=)[^&\s)"'`<>/]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)"'`<>/]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)"'`<>]+/gi, '$1<redacted>')
    .replace(/\b((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)\s*=\s*)[^&\s)"'`<>]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function displayPath(file) {
  const absolute = path.resolve(file)
  const relative = path.relative(process.cwd(), absolute)
  const isInsideCwd = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
  return redactString(isInsideCwd ? relative.replaceAll('\\', '/') : path.basename(absolute))
}

function archiveRelativePath(file, outputDir) {
  return path.relative(outputDir, file).replaceAll('\\', '/')
}

function isImageFile(file) {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function pathsOverlap(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)
}

function walkDirectory(dir, warnings) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkDirectory(file, warnings))
    } else if (entry.isFile() && isImageFile(file)) {
      files.push(file)
    } else if (entry.isFile()) {
      warnings.push(`ignored non-image file: ${displayPath(file)}`)
    }
  }
  return files
}

function collectScreenshotFiles(inputs) {
  const warnings = []
  const files = []

  for (const input of inputs) {
    if (!existsSync(input)) {
      warnings.push(`missing input: ${displayPath(input)}`)
      continue
    }

    const stats = statSync(input)
    if (stats.isDirectory()) {
      files.push(...walkDirectory(input, warnings))
    } else if (stats.isFile() && isImageFile(input)) {
      files.push(input)
    } else if (stats.isFile()) {
      warnings.push(`ignored non-image file: ${displayPath(input)}`)
    } else {
      warnings.push(`ignored unsupported input: ${displayPath(input)}`)
    }
  }

  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))].sort()
  return {
    files: uniqueFiles,
    warnings: warnings.map((warning) => redactString(warning)),
  }
}

function validateOutputDir(opts) {
  for (const input of opts.inputs) {
    if (!existsSync(input) || !statSync(input).isDirectory()) continue
    if (pathsOverlap(opts.outputDir, input)) {
      throw new Error('--output-dir must not overlap with any input directory')
    }
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex')
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeReadme(file, summary) {
  const lines = [
    '# DingTalk Screenshot Evidence Archive',
    '',
    `- Status: **${summary.status}**`,
    `- Generated at: ${summary.generatedAt}`,
    `- Screenshot count: ${summary.screenshotCount}`,
    `- Input count: ${summary.inputCount}`,
    '',
    '## Security Notes',
    '',
    '- Source labels are path-only metadata with token-like values redacted.',
    '- Screenshot files are renamed to stable archive names and should remain access-restricted because pixels may contain personal or operational data.',
    '- This archive proves packaging integrity only; it does not OCR or validate screenshot content.',
    '',
    '## Screenshots',
    '',
  ]

  if (summary.copiedScreenshots.length === 0) {
    lines.push('_No screenshot files were archived._', '')
  } else {
    lines.push('| # | Archive path | Source label | Size | SHA-256 |')
    lines.push('|---:|---|---|---:|---|')
    for (const screenshot of summary.copiedScreenshots) {
      lines.push(
        `| ${screenshot.index} | \`${screenshot.archivePath}\` | \`${screenshot.sourceLabel}\` | ${screenshot.sizeBytes} | \`${screenshot.sha256}\` |`,
      )
    }
    lines.push('')
  }

  if (summary.warnings.length > 0) {
    lines.push('## Warnings', '')
    for (const warning of summary.warnings) {
      lines.push(`- ${warning}`)
    }
    lines.push('')
  }

  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function buildScreenshotArchive(opts) {
  validateOutputDir(opts)

  const generatedAt = new Date().toISOString()
  const { files, warnings } = collectScreenshotFiles(opts.inputs)
  const outputDir = path.resolve(opts.outputDir)
  const screenshotDir = path.join(outputDir, 'screenshots')
  const manifestJson = path.join(outputDir, 'manifest.json')
  const readmeMd = path.join(outputDir, 'README.md')

  mkdirSync(outputDir, { recursive: true })
  if (files.length > 0) mkdirSync(screenshotDir, { recursive: true })

  const copiedScreenshots = files.map((source, index) => {
    const extension = path.extname(source).toLowerCase()
    const archiveName = `screenshot-${String(index + 1).padStart(3, '0')}${extension}`
    const archiveFile = path.join(screenshotDir, archiveName)
    copyFileSync(source, archiveFile)

    return {
      index: index + 1,
      sourceLabel: displayPath(source),
      archivePath: archiveRelativePath(archiveFile, outputDir),
      extension,
      sizeBytes: statSync(source).size,
      sha256: sha256File(source),
    }
  })

  const summaryWarnings = [...warnings]
  if (files.length === 0) summaryWarnings.push('no screenshot images found')

  const status = files.length > 0 || opts.allowEmpty ? 'pass' : 'fail'
  const summary = {
    tool: 'dingtalk-screenshot-archive',
    generatedAt,
    status,
    allowEmpty: opts.allowEmpty,
    outputDir: redactString(relativePath(outputDir)),
    manifestJson: redactString(relativePath(manifestJson)),
    readmeMd: redactString(relativePath(readmeMd)),
    inputCount: opts.inputs.length,
    screenshotCount: copiedScreenshots.length,
    copiedScreenshots,
    warnings: summaryWarnings.map((warning) => redactString(warning)),
  }

  writeJson(manifestJson, summary)
  writeReadme(readmeMd, summary)
  return summary
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    const summary = buildScreenshotArchive(opts)
    console.log(
      `[dingtalk-screenshot-archive] ${summary.status}: ${summary.screenshotCount} screenshot(s), manifest=${summary.manifestJson}`,
    )
    if (summary.status !== 'pass') process.exit(1)
  } catch (error) {
    console.error(`[dingtalk-screenshot-archive] ERROR: ${redactString(error.message)}`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}

export {
  buildScreenshotArchive,
  collectScreenshotFiles,
  displayPath,
  isImageFile,
  parseArgs,
  redactString,
}
