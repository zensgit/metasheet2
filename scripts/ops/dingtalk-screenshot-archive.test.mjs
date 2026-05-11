import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-screenshot-archive.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-screenshot-archive-'))
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function writeFixture(file, content = 'fixture-image-bytes') {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('dingtalk-screenshot-archive copies nested screenshots and writes manifest docs', () => {
  const tmpDir = makeTmpDir()
  const inputDir = path.join(tmpDir, 'evidence')
  const outputDir = path.join(tmpDir, 'archive')

  try {
    writeFixture(path.join(inputDir, 'mobile-form.png'), 'png-one')
    writeFixture(path.join(inputDir, 'nested', 'group-message.JPG'), 'jpg-two')
    writeFixture(path.join(inputDir, 'notes.txt'), 'not an image')

    const result = runScript(['--input', inputDir, '--output-dir', outputDir])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(path.join(outputDir, 'manifest.json')), true)
    assert.equal(existsSync(path.join(outputDir, 'README.md')), true)
    assert.equal(existsSync(path.join(outputDir, 'screenshots', 'screenshot-001.png')), true)
    assert.equal(existsSync(path.join(outputDir, 'screenshots', 'screenshot-002.jpg')), true)

    const manifest = readJson(path.join(outputDir, 'manifest.json'))
    assert.equal(manifest.status, 'pass')
    assert.equal(manifest.screenshotCount, 2)
    assert.equal(manifest.copiedScreenshots[0].archivePath, 'screenshots/screenshot-001.png')
    assert.equal(manifest.copiedScreenshots[1].archivePath, 'screenshots/screenshot-002.jpg')
    assert.equal(manifest.warnings.some((warning) => warning.includes('notes.txt')), true)
    assert.match(readFileSync(path.join(outputDir, 'README.md'), 'utf8'), /Screenshot count: 2/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-screenshot-archive redacts token-like values from manifest and README', () => {
  const tmpDir = makeTmpDir()
  const inputDir = path.join(tmpDir, 'evidence')
  const outputDir = path.join(tmpDir, 'access_token=archive-secret', 'archive')

  try {
    writeFixture(
      path.join(inputDir, 'access_token=robot-secret SECabcdef1234567890 Bearer secret-token screenshot.png'),
      'png-secret',
    )

    const result = runScript(['--input', inputDir, '--output-dir', outputDir])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const manifestText = readFileSync(path.join(outputDir, 'manifest.json'), 'utf8')
    const readmeText = readFileSync(path.join(outputDir, 'README.md'), 'utf8')
    assert.doesNotMatch(manifestText, /robot-secret/)
    assert.doesNotMatch(readmeText, /robot-secret/)
    assert.doesNotMatch(manifestText, /archive-secret/)
    assert.doesNotMatch(result.stdout, /archive-secret/)
    assert.doesNotMatch(manifestText, /SECabcdef1234567890/)
    assert.doesNotMatch(readmeText, /SECabcdef1234567890/)
    assert.doesNotMatch(manifestText, /secret-token/)
    assert.doesNotMatch(readmeText, /secret-token/)
    assert.match(manifestText, /access_token=<redacted>/)
    assert.match(manifestText, /SEC<redacted>/)
    assert.match(manifestText, /Bearer <redacted>/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-screenshot-archive fails empty input by default but writes failure summary', () => {
  const tmpDir = makeTmpDir()
  const inputDir = path.join(tmpDir, 'empty')
  const outputDir = path.join(tmpDir, 'archive')

  try {
    mkdirSync(inputDir, { recursive: true })

    const result = runScript(['--input', inputDir, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    assert.match(result.stdout, /fail: 0 screenshot/)
    const manifest = readJson(path.join(outputDir, 'manifest.json'))
    assert.equal(manifest.status, 'fail')
    assert.equal(manifest.screenshotCount, 0)
    assert.equal(manifest.warnings.includes('no screenshot images found'), true)
    assert.match(readFileSync(path.join(outputDir, 'README.md'), 'utf8'), /No screenshot files were archived/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-screenshot-archive supports explicit allow-empty archive runs', () => {
  const tmpDir = makeTmpDir()
  const inputDir = path.join(tmpDir, 'empty')
  const outputDir = path.join(tmpDir, 'archive')

  try {
    mkdirSync(inputDir, { recursive: true })

    const result = runScript(['--input', inputDir, '--output-dir', outputDir, '--allow-empty'])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const manifest = readJson(path.join(outputDir, 'manifest.json'))
    assert.equal(manifest.status, 'pass')
    assert.equal(manifest.allowEmpty, true)
    assert.equal(manifest.screenshotCount, 0)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-screenshot-archive rejects archives nested inside an input directory', () => {
  const tmpDir = makeTmpDir()
  const inputDir = path.join(tmpDir, 'evidence')
  const outputDir = path.join(inputDir, 'archive')

  try {
    writeFixture(path.join(inputDir, 'mobile-form.png'), 'png-one')

    const result = runScript(['--input', inputDir, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /--output-dir must not overlap with any input directory/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
