import fs from 'fs/promises'
import path from 'path'

const ROOT = path.resolve('output/playwright/multitable-pilot-ready-local')
const outputRoot = process.env.HANDOFF_OUTPUT_ROOT || path.resolve('output/playwright/multitable-pilot-handoff')
const sourceRoot = process.env.READINESS_ROOT || ''

const runbookPath = path.resolve('docs/deployment/multitable-internal-pilot-runbook-20260319.md')
const feedbackTemplatePath = path.resolve('docs/deployment/multitable-pilot-feedback-template-20260319.md')
const issueTemplatePath = path.resolve('.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml')

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveLatestReadinessRoot() {
  if (sourceRoot) return path.resolve(sourceRoot)
  const entries = await fs.readdir(ROOT, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const latest = dirs.at(-1)
  if (!latest) {
    throw new Error(`No readiness runs found under ${ROOT}`)
  }
  return path.join(ROOT, latest)
}

async function safeCopy(from, to) {
  if (!(await exists(from))) return false
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  return true
}

function rel(filePath) {
  return path.relative(process.cwd(), filePath) || '.'
}

async function main() {
  const readinessRoot = await resolveLatestReadinessRoot()
  const stamp = path.basename(readinessRoot)
  const handoffRoot = path.join(outputRoot, stamp)

  await fs.mkdir(handoffRoot, { recursive: true })

  const readinessMd = path.join(readinessRoot, 'readiness.md')
  const readinessJson = path.join(readinessRoot, 'readiness.json')
  const smokeReport = path.join(readinessRoot, 'smoke', 'report.json')
  const profileReport = path.join(readinessRoot, 'profile', 'report.json')
  const profileSummary = path.join(readinessRoot, 'profile', 'summary.md')

  const copied = {
    readinessMd: await safeCopy(readinessMd, path.join(handoffRoot, 'readiness.md')),
    readinessJson: await safeCopy(readinessJson, path.join(handoffRoot, 'readiness.json')),
    smokeReport: await safeCopy(smokeReport, path.join(handoffRoot, 'smoke', 'report.json')),
    profileReport: await safeCopy(profileReport, path.join(handoffRoot, 'profile', 'report.json')),
    profileSummary: await safeCopy(profileSummary, path.join(handoffRoot, 'profile', 'summary.md')),
    runbook: await safeCopy(runbookPath, path.join(handoffRoot, 'docs', path.basename(runbookPath))),
    feedbackTemplate: await safeCopy(
      feedbackTemplatePath,
      path.join(handoffRoot, 'docs', path.basename(feedbackTemplatePath)),
    ),
    issueTemplate: await safeCopy(
      issueTemplatePath,
      path.join(handoffRoot, 'docs', 'issue-template', path.basename(issueTemplatePath)),
    ),
  }

  const manifest = {
    ok: copied.readinessMd && copied.readinessJson,
    sourceReadinessRoot: readinessRoot,
    handoffRoot,
    copied,
    generatedAt: new Date().toISOString(),
  }

  const summary = [
    '# Multitable Pilot Handoff',
    '',
    `- Source readiness root: \`${readinessRoot}\``,
    `- Handoff root: \`${handoffRoot}\``,
    `- Readiness package copied: **${manifest.ok ? 'YES' : 'NO'}**`,
    '',
    '## Included Files',
    '',
    `- readiness.md: ${copied.readinessMd ? '`present`' : '`missing`'}`,
    `- readiness.json: ${copied.readinessJson ? '`present`' : '`missing`'}`,
    `- smoke/report.json: ${copied.smokeReport ? '`present`' : '`missing`'}`,
    `- profile/report.json: ${copied.profileReport ? '`present`' : '`missing`'}`,
    `- profile/summary.md: ${copied.profileSummary ? '`present`' : '`missing`'}`,
    `- runbook: ${copied.runbook ? '`present`' : '`missing`'}`,
    `- feedback template: ${copied.feedbackTemplate ? '`present`' : '`missing`'}`,
    `- issue template: ${copied.issueTemplate ? '`present`' : '`missing`'}`,
    '',
    '## Next Step',
    '',
    '- Give the pilot team the `docs/` bundle plus the readiness artifacts, then collect feedback with the template or GitHub issue form.',
    '',
  ].join('\n')

  await fs.writeFile(path.join(handoffRoot, 'handoff.md'), `${summary}\n`, 'utf8')
  await fs.writeFile(path.join(handoffRoot, 'handoff.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  process.stdout.write(`[multitable-pilot-handoff] handoff_root=${rel(handoffRoot)}\n`)
  process.stdout.write(`[multitable-pilot-handoff] source_readiness_root=${rel(readinessRoot)}\n`)
  if (!manifest.ok) {
    process.stderr.write('[multitable-pilot-handoff] ERROR: readiness artifacts missing\n')
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`[multitable-pilot-handoff] ERROR: ${error.message}\n`)
  process.exit(1)
})
